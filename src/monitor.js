import { chromium } from 'playwright'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PROFILE_DIR = path.join(ROOT, '.profile')
const SHOTS_DIR = path.join(ROOT, 'capturas')

const START_URL = 'https://icp.administracionelectronica.gob.es/icpplus/index.html'
const PROVINCIA_BARCELONA = '/icpplustieb/citar?p=8&locale=es'
const TRAMITE_HUELLAS = '4010'
const SITE_HOST = 'icp.administracionelectronica.gob.es'
const CLAVE_HOST_RE = /(^|\.)clave\.gob\.es$|seg-social\.gob\.es$/i
// El servidor no envía el certificado intermedio y Chromium lo rechaza.
const INTERMEDIATE_URL = 'http://cacerts.digicert.com/RapidSSLTLSRSACAG1.crt'

const configSchema = z.object({
  NIE: z.string().regex(/^[XYZ]\d{7}[A-Z]$/i, 'NIE con formato X1234567A'),
  NOMBRE: z.string().min(3),
  PAIS_CODIGO: z.string().default('406'),
  SEDE: z.string().default('99'),
  MAIL_TO: z.string().email(),
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  MAIL_FROM: z.string().default('Monitor Citas <onboarding@resend.dev>'),
  AUTO_BOOK: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TELEFONO: z.string().regex(/^[67]\d{8}$/, 'Teléfono móvil español de 9 cifras').optional(),
  EMAIL_CITA: z.string().email().optional(),
  INTERVALO_MIN: z.coerce.number().min(1).default(4),
  INTERVALO_MAX: z.coerce.number().min(1).default(7),
  // Segundos de espera tras un "no hay citas"; sin valor, usa INTERVALO_MIN/MAX
  ESPERA_SIN_CITAS_SEG: z.coerce.number().min(1).optional(),
  TEXTBELT_API_KEY: z.string().min(10).optional(),
  SMS_PHONE: z.string().regex(/^\+\d{8,15}$/, 'Teléfono con prefijo internacional, p. ej. +34600000000').optional(),
  USE_CLAVE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CERT_PFX_PATH: z.string().optional(),
  CERT_PASSWORD: z.string().optional(),
  // Orígenes exactos donde la pasarela Cl@ve pide el certificado de cliente
  CLAVE_CERT_ORIGINS: z
    .string()
    .default(
      'https://clave-dninbrt.seg-social.gob.es,https://pasarela.clave.gob.es,https://pasarela-ident.clave.gob.es,https://se-pasarela.clave.gob.es',
    )
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
})

const log = (msg) => process.stdout.write(`[${new Date().toLocaleString('es-ES')}] ${msg}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const humanPause = () => sleep(800 + Math.random() * 1500)

function loadConfig() {
  const parsed = configSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Configuración inválida en .env:\n${issues}`)
  }
  const cfg = parsed.data
  if (cfg.AUTO_BOOK && (!cfg.TELEFONO || !cfg.EMAIL_CITA)) {
    throw new Error('AUTO_BOOK=true requiere TELEFONO y EMAIL_CITA en .env')
  }
  if (cfg.USE_CLAVE && (!cfg.CERT_PFX_PATH || !cfg.CERT_PASSWORD)) {
    throw new Error('USE_CLAVE=true requiere CERT_PFX_PATH y CERT_PASSWORD en .env')
  }
  return cfg
}

// ---------- avisos ----------

// Texto por variables de entorno para no interpolarlo en el script de PowerShell
const WINDOWS_TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$title = [Security.SecurityElement]::Escape($env:NOTIFY_TITLE)
$body = [Security.SecurityElement]::Escape($env:NOTIFY_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual><audio src='ms-winsoundevent:Notification.Looping.Alarm'/></toast>")
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
[System.Media.SystemSounds]::Exclamation.Play()
`

function desktopNotify(title, body) {
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`
    execFile('osascript', ['-e', script], () => {})
    execFile('afplay', ['/System/Library/Sounds/Sosumi.aiff'], () => {})
  } else if (process.platform === 'win32') {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST_SCRIPT],
      { env: { ...process.env, NOTIFY_TITLE: title, NOTIFY_BODY: body }, windowsHide: true },
      (error) => error && log(`ERROR notificación Windows: ${error.message}`),
    )
  }
}

async function sendMail(cfg, subject, text, attachments = []) {
  if (!cfg.RESEND_API_KEY) {
    log('AVISO: sin RESEND_API_KEY, no se envía correo (solo notificación de escritorio)')
    return
  }
  try {
    const files = await Promise.all(
      attachments.map(async (a) => ({ filename: a.filename, content: (await readFile(a.path)).toString('base64') })),
    )
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.MAIL_FROM, to: [cfg.MAIL_TO], subject, text, attachments: files }),
    })
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
    log(`Correo enviado a ${cfg.MAIL_TO}: ${subject}`)
  } catch (error) {
    log(`ERROR enviando correo: ${error.message}`)
  }
}

async function sendSms(cfg, message) {
  if (!cfg.TEXTBELT_API_KEY || !cfg.SMS_PHONE) return
  try {
    const res = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone: cfg.SMS_PHONE, message, key: cfg.TEXTBELT_API_KEY }),
    })
    const result = await res.json()
    if (!result.success) throw new Error(result.error ?? `Textbelt ${res.status}`)
    log(`SMS enviado a ${cfg.SMS_PHONE} (quedan ${result.quotaRemaining})`)
  } catch (error) {
    log(`ERROR enviando SMS: ${error.message}`)
  }
}

async function alert(cfg, subject, text, page) {
  desktopNotify('Cita extranjería', subject)
  const attachments = []
  if (page) {
    const file = await screenshot(page, 'aviso')
    if (file) attachments.push({ filename: path.basename(file), path: file })
  }
  await sendMail(cfg, subject, text, attachments)
}

async function screenshot(page, name) {
  try {
    await mkdir(SHOTS_DIR, { recursive: true })
    const file = path.join(SHOTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    return file
  } catch {
    return null
  }
}

// ---------- certificado del sitio ----------

let intermediatePem

/** Descarga el intermedio y comprueba que lo firma una raíz de confianza. */
async function loadIntermediate() {
  const res = await fetch(INTERMEDIATE_URL)
  if (!res.ok) throw new Error(`No se pudo descargar el intermedio: ${res.status}`)
  const cert = new X509Certificate(Buffer.from(await res.arrayBuffer()))
  const signedByRoot = tls.rootCertificates.some((pem) => {
    const root = new X509Certificate(pem)
    return cert.checkIssued(root) && cert.verify(root.publicKey)
  })
  if (!signedByRoot) throw new Error('El certificado intermedio no lo firma ninguna raíz de confianza')
  return cert.toString()
}

/** Verifica la cadena TLS del sitio desde Node y devuelve los datos del certificado. */
async function verifySiteCert() {
  intermediatePem ??= await loadIntermediate()
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: SITE_HOST, port: 443, servername: SITE_HOST, ca: [...tls.rootCertificates, intermediatePem] },
      () => {
        const peer = socket.getPeerCertificate()
        socket.end()
        if (!socket.authorized) return reject(new Error(`Certificado no válido: ${socket.authorizationError}`))
        resolve({ subject: peer.subject.CN, issuer: peer.issuer.CN, validTo: Date.parse(peer.valid_to) / 1000 })
      },
    )
    socket.setTimeout(30_000, () => socket.destroy(new Error('Timeout verificando certificado')))
    socket.on('error', reject)
  })
}

/** El navegador ignora errores TLS; aquí exigimos que su certificado sea el verificado por Node. */
async function assertTrusted(response, expected) {
  if (!response || new URL(response.url()).hostname !== SITE_HOST) return
  const details = await response.securityDetails()
  const ok =
    details &&
    details.subjectName === expected.subject &&
    details.issuer === expected.issuer &&
    Math.abs(details.validTo - expected.validTo) < 2
  if (!ok) throw new Error(`Certificado del navegador no coincide con el verificado: ${JSON.stringify(details)}`)
}

// ---------- navegación ----------

class BlockedError extends Error {}

async function assertNotBlocked(page) {
  if (/requested url was rejected|too many requests/i.test(await bodyText(page))) {
    throw new BlockedError('La web ha rechazado la petición')
  }
}

async function clickAndWait(page, target, siteCert) {
  await humanPause()
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
    typeof target === 'string' ? page.click(target) : target.click(),
  ])
  await assertTrusted(response, siteCert)
  await assertNotBlocked(page)
}

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')) || ''
}

async function fillIfEmpty(page, selector, value) {
  const field = page.locator(selector)
  if (!(await field.count()) || (await field.inputValue()).trim()) return
  await field.fill(value)
}

/** Pasa por la pasarela Cl@ve con el certificado electrónico y vuelve a la web de citas. */
async function loginClave(page) {
  await humanPause()
  await Promise.all([
    page.waitForURL((url) => CLAVE_HOST_RE.test(url.hostname), { timeout: 60_000 }),
    page.click('#btnAccesoClave'),
  ])
  log(`Pasarela Cl@ve: ${new URL(page.url()).hostname}`)
  await page.waitForLoadState('domcontentloaded')

  const certOption = page
    .locator('[onclick*="AFIRMA" i], [onclick*="certific" i]')
    .or(page.locator('article, section, li, div.card').filter({ hasText: /DNIe\s*\/\s*Certificado/i }).getByRole('button', { name: /acceder/i }))
    .first()
  // Una sesión Cl@ve aún válida puede devolvernos directamente a la web de citas
  const backOnSite = page.waitForURL((url) => url.hostname === SITE_HOST, { timeout: 30_000 }).then(() => 'site')
  const optionShown = certOption.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'option')
  backOnSite.catch(() => {})
  optionShown.catch(() => {})
  if ((await Promise.race([backOnSite, optionShown])) === 'option') {
    await humanPause()
    await certOption.click()
  }

  // Tras autenticar puede haber pantallas intermedias de consentimiento/continuar
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (new URL(page.url()).hostname === SITE_HOST) break
    const proceed = page.getByRole('button', { name: /^(continuar|aceptar|acceder|enviar)$/i }).first()
    if (await proceed.isVisible().catch(() => false)) await proceed.click().catch(() => {})
    await sleep(2_000)
  }
  if (new URL(page.url()).hostname !== SITE_HOST) {
    throw new Error(`Login Cl@ve no completado, sigue en ${page.url()}`)
  }
  await page.waitForLoadState('domcontentloaded')
  await assertNotBlocked(page)
  log('Login Cl@ve completado')
}

function classify(text, url) {
  if (/no hay citas disponibles(?! en esta sede)/i.test(text) && !/citar\?p=/.test(url)) return 'NO_CITAS'
  if (/too many requests|requested url was rejected|demasiadas peticiones|se ha producido un error/i.test(text)) return 'BLOQUEADO'
  if (/sesi[oó]n.*(caducado|expirado)/i.test(text)) return 'SESION'
  if (/acOfertarCita|acVerFormulario|acGestionarCita|acCitar/i.test(url) || /seleccion(e|a).*(oficina|cita)|disponibles/i.test(text)) return 'DISPONIBLE'
  return 'DESCONOCIDO'
}

/**
 * Clasifica la página ya cargada. El texto puede tardar en aparecer y la URL
 * acCitar* también sale con "no hay citas", así que un DISPONIBLE se confirma
 * releyendo la página unos segundos después.
 */
async function classifyPage(page) {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
  const read = async () => {
    for (let i = 0; i < 10; i++) {
      const text = await bodyText(page)
      if (/cita previa|rejected|too many requests|demasiadas peticiones/i.test(text)) return text
      await sleep(1_000)
    }
    return bodyText(page)
  }
  const first = classify(await read(), page.url())
  if (first !== 'DISPONIBLE') return first
  await sleep(3_000)
  return classify(await read(), page.url())
}

/** Recorre el formulario hasta el resultado de "Solicitar Cita". */
async function runCheck(page, cfg) {
  const siteCert = await verifySiteCert()
  const next = (selector) => clickAndWait(page, selector, siteCert)
  await assertTrusted(await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }), siteCert)
  await assertNotBlocked(page)

  await page.selectOption('#form', PROVINCIA_BARCELONA)
  await next('#btnAceptar')

  // Cambiar la oficina recarga la lista de trámites: esperar a que termine
  const tramite = page.locator('[id="tramiteGrupo[0]"]')
  if ((await page.inputValue('#sede').catch(() => cfg.SEDE)) !== cfg.SEDE) {
    await page.selectOption('#sede', cfg.SEDE)
    await page.waitForLoadState('networkidle').catch(() => {})
  }
  await tramite.locator(`option[value="${TRAMITE_HUELLAS}"]`).waitFor({ state: 'attached', timeout: 30_000 })
  await humanPause()
  await tramite.selectOption(TRAMITE_HUELLAS)
  if ((await tramite.inputValue()) !== TRAMITE_HUELLAS) throw new Error('No se pudo seleccionar el trámite')
  await next('#btnAceptar')

  if (cfg.USE_CLAVE) {
    await loginClave(page)
    return afterClave(page, cfg, next)
  } else {
    await next('#btnEntrar')

    await page.check('#rdbTipoDocNie').catch(() => {})
    await page.fill('#txtIdCitado', cfg.NIE.toUpperCase())
    await page.fill('#txtDesCitado', cfg.NOMBRE.toUpperCase())
    await page.selectOption('#txtPaisNac', cfg.PAIS_CODIGO)
    await next('#btnEnviar')
  }

  // Página "Solicitar Cita / Consultar / Anular"
  const early = await classifyPage(page)
  if (early === 'BLOQUEADO' || early === 'SESION') return early
  if (await page.locator('#btnEnviar').count()) {
    await next('#btnEnviar')
  }

  return classifyPage(page)
}

/**
 * Página del solicitante tras Cl@ve: rellena con "Copiar a datos solicitante",
 * elige el país y busca citas.
 */
async function afterClave(page, cfg, next) {
  await page.locator('#txtIdCitado').waitFor({ state: 'attached', timeout: 30_000 })

  await page.click('#cookie_action_close_header', { timeout: 2_000 }).catch(() => {})
  await page.check('#rdbTipoDocNie').catch(() => {})
  if (await page.locator('#btnCopiar').count()) {
    await page.click('#btnCopiar')
    await humanPause()
  }
  // Con Cl@ve solo viene el usuario; si "Copiar" no rellena, escribir los datos
  await fillIfEmpty(page, '#txtIdCitado', cfg.NIE.toUpperCase())
  await fillIfEmpty(page, '#txtDesCitado', cfg.NOMBRE.toUpperCase())
  await page.selectOption('#txtPaisNac', cfg.PAIS_CODIGO)
  await screenshot(page, 'antes-de-enviar')
  await next('#btnEnviar')

  const early = await classifyPage(page)
  if (early === 'BLOQUEADO' || early === 'SESION') return early
  if (await page.locator('#btnEnviar').count()) await next('#btnEnviar')
  return classifyPage(page)
}

/** Intenta reservar la primera hora. Devuelve true si se confirmó. */
async function autoBook(page, cfg) {
  const siteCert = await verifySiteCert()
  const next = (selector) => clickAndWait(page, selector, siteCert)
  for (let step = 0; step < 6; step++) {
    await screenshot(page, `reserva-paso${step}`)
    const text = await bodyText(page)

    if (/cita confirmada|justificante de cita|n[uú]mero de justificante/i.test(text)) {
      return true
    }
    if (await page.locator('#txtCodigoVerificacion, [id*="CodigoSMS" i]').count()) {
      log('La web pide código SMS: hay que terminar a mano')
      return false
    }
    if (await page.locator('#idSede').count()) {
      const options = await page.locator('#idSede option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
      if (!options.length) return false
      await page.selectOption('#idSede', options[0])
      await next('#btnSiguiente')
      continue
    }
    if (await page.locator('#txtTelefonoCitado').count()) {
      await page.fill('#txtTelefonoCitado', cfg.TELEFONO)
      await page.fill('#emailUNO', cfg.EMAIL_CITA).catch(() => {})
      await page.fill('#emailDOS', cfg.EMAIL_CITA).catch(() => {})
      await next('#btnSiguiente')
      continue
    }
    const slot = page.locator('input[type=radio][id^="rdbCita"], input[type=radio][name*="cita" i]').first()
    if (await slot.count()) {
      await slot.check()
      await next('#btnSiguiente')
      continue
    }
    if (await page.locator('#btnConfirmar').count()) {
      await page.check('#chkTotal').catch(() => {})
      await page.check('#enviarCorreo').catch(() => {})
      await next('#btnConfirmar')
      continue
    }
    log('Paso de reserva no reconocido')
    return false
  }
  return false
}

// ---------- bucle ----------

async function openBrowser(cfg) {
  const clientCertificates = cfg.USE_CLAVE
    ? cfg.CLAVE_CERT_ORIGINS.map((origin) => ({ origin, pfxPath: cfg.CERT_PFX_PATH, passphrase: cfg.CERT_PASSWORD }))
    : undefined
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    ignoreHTTPSErrors: true,
    locale: 'es-ES',
    viewport: { width: 1200, height: 900 },
    clientCertificates,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('dialog', (d) => d.accept().catch(() => {}))
  // Registrar los hosts de la pasarela para poder ajustar CLAVE_CERT_ORIGINS
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    const { origin, hostname } = new URL(frame.url())
    if (cfg.USE_CLAVE && CLAVE_HOST_RE.test(hostname)) log(`Cl@ve navega a ${origin}`)
  })
  return { context, page }
}

async function main() {
  const args = process.argv.slice(2)
  const cfg = loadConfig()

  if (args.includes('--test-mail')) {
    await sendMail(cfg, 'Prueba monitor citas', 'Si lees esto, el aviso por correo funciona.')
    return
  }
  if (args.includes('--test-sms')) {
    await sendSms(cfg, 'Prueba monitor citas: si lees esto, el aviso por SMS funciona.')
    return
  }
  if (cfg.USE_CLAVE) await access(cfg.CERT_PFX_PATH)

  let { context, page } = await openBrowser(cfg)

  const once = args.includes('--once')
  let bloqueos = 0
  let avisadoDesconocido = false

  for (;;) {
    if (page.isClosed()) {
      log('La ventana del navegador se cerró: reabriendo')
      await context.close().catch(() => {})
      ;({ context, page } = await openBrowser(cfg))
    }

    let result
    try {
      result = await runCheck(page, cfg)
    } catch (error) {
      // Un timeout puede esconder una página de bloqueo cargada después
      const blocked = error instanceof BlockedError || (!page.isClosed() && classify(await bodyText(page), page.url()) === 'BLOQUEADO')
      result = blocked ? 'BLOQUEADO' : 'ERROR'
      log(`Error en la comprobación: ${error.message.split('\n')[0]}`)
      await screenshot(page, 'error')
    }
    if (!page.isClosed()) await page.screenshot({ path: path.join(ROOT, 'ultima-comprobacion.png'), fullPage: true }).catch(() => {})
    log(`Resultado: ${result} (${page.isClosed() ? '-' : new URL(page.url()).pathname})`)

    if (result === 'DISPONIBLE') {
      await alert(
        cfg,
        '¡HAY CITAS! Toma de huellas Barcelona',
        `Hay citas disponibles para ${cfg.NOMBRE} (${cfg.NIE}).\n` +
          (cfg.AUTO_BOOK
            ? 'El monitor está intentando reservar la primera hora.'
            : 'La ventana de Chrome del monitor ya está en la página de citas: ve al ordenador y termina la reserva.\n' +
              'Si no llegas a tiempo: https://icp.administracionelectronica.gob.es/icpplus/index.html'),
        page,
      )
      await sendSms(cfg, `Hay citas de huellas${cfg.USE_CLAVE ? ' (Cl@ve)' : ''}! Termina la reserva en la ventana del monitor.`)

      if (cfg.AUTO_BOOK) {
        const ok = await autoBook(page, cfg).catch((e) => {
          log(`Error reservando: ${e.message.split('\n')[0]}`)
          return false
        })
        const shot = await screenshot(page, ok ? 'confirmada' : 'reserva-incompleta')
        await sendMail(
          cfg,
          ok ? 'CITA RESERVADA - toma de huellas' : 'Reserva automática NO completada: termina a mano',
          ok
            ? `Cita reservada. Texto de la página:\n\n${(await bodyText(page)).slice(0, 3000)}`
            : 'No se pudo completar la reserva automática. La ventana del monitor sigue abierta en el paso actual.',
          shot ? [{ filename: path.basename(shot), path: shot }] : [],
        )
        desktopNotify('Cita extranjería', ok ? 'CITA RESERVADA' : 'Termina la reserva a mano')
      }

      log('Monitor en pausa. La ventana queda abierta. Ctrl+C para salir.')
      await new Promise(() => {})
    }

    if (result === 'DESCONOCIDO' && !avisadoDesconocido) {
      avisadoDesconocido = true
      await alert(cfg, 'Monitor de citas: página inesperada', 'Revisa la captura adjunta; puede que haya citas o que la web haya cambiado.', page)
    } else if (result !== 'DESCONOCIDO') {
      avisadoDesconocido = false
    }

    if (once) break

    bloqueos = result === 'BLOQUEADO' ? bloqueos + 1 : 0
    const base = cfg.INTERVALO_MIN + Math.random() * Math.max(0, cfg.INTERVALO_MAX - cfg.INTERVALO_MIN)
    // Si la web nos bloquea, esperar más (hasta 1 h)
    const minutes = Math.min(60, base * 2 ** bloqueos)
    if (bloqueos === 3) {
      await alert(cfg, 'Monitor de citas bloqueado', 'La web está rechazando las peticiones. El monitor sigue reintentando más despacio.')
    }
    if (result === 'NO_CITAS' && cfg.ESPERA_SIN_CITAS_SEG) {
      log(`Próxima comprobación en ${cfg.ESPERA_SIN_CITAS_SEG} s`)
      await sleep(cfg.ESPERA_SIN_CITAS_SEG * 1_000)
      continue
    }
    log(`Próxima comprobación en ${minutes.toFixed(1)} min`)
    await sleep(minutes * 60_000)
  }

  await context.close()
}

main().catch((error) => {
  log(`FATAL: ${error.message}`)
  process.exit(1)
})
