# Monitor cita previa extranjería — Toma de huellas (Barcelona)

Comprueba cada 4–7 min si hay citas para **POLICÍA-TOMA DE HUELLAS (EXPEDICIÓN DE TARJETA)** en cualquier oficina de Barcelona.
Cuando hay citas: notificación de escritorio (macOS o Windows) + sonido + correo con captura. Opcionalmente intenta reservar la primera hora.

## Configuración

```bash
cp .env.example .env
```

Rellenar en `.env`:

- `NIE` — obligatorio (la web no permite pasaporte para este trámite en Barcelona).
- `RESEND_API_KEY` — API key de Resend. Sin dominio verificado solo envía al email de la cuenta de Resend.
- `AUTO_BOOK=true` + `TELEFONO` si quieres que reserve solo.
- `TEXTBELT_API_KEY` + `SMS_PHONE` para recibir también un SMS cuando haya citas.

## Presentación con Cl@ve

Con Cl@ve la web ofrece citas que no aparecen sin Cl@ve. Con `USE_CLAVE=true` el monitor pulsa
"Presentación con Cl@ve" y se identifica con el certificado electrónico (`CERT_PFX_PATH` + `CERT_PASSWORD`).
Solo funciona con certificado: Cl@ve PIN y Cl@ve Permanente piden un código en el móvil cada vez.

Si el login falla, el log muestra `Cl@ve navega a https://...`: añade ese origen a `CLAVE_CERT_ORIGINS`.

## Uso

```bash
npm run test-mail   # prueba el correo
npm run once        # una comprobación
npm start           # bucle continuo
```

Se abre una ventana de Chromium: no cerrarla. Cuando hay citas, el monitor se para y deja la ventana en la página de citas para terminar a mano (la sesión de la web no se puede abrir desde el enlace del correo).

## Límites

- Si aparece un CAPTCHA o la web pide código SMS, hay que completarlo a mano en la ventana.
- Intervalo por defecto 2–3 min. Más rápido = más riesgo de que la web bloquee la IP durante horas. Ante bloqueos el monitor espera cada vez más (máx. 1 h).
- El ordenador debe estar encendido y sin suspender. macOS: `caffeinate -i npm start`. Windows 11: Configuración > Sistema > Energía > Suspender = Nunca, luego `npm start`.
