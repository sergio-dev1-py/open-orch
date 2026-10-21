# OpenOrch Browser (extensión para Edge/Chrome)

Esta extensión permite que tu agente de **OpenOrch** use tu navegador real (tu sesión, tus cookies y tus logins) para navegar, leer páginas, hacer clic, rellenar formularios y comprar, siempre con permiso por sitio y solo en pestañas del grupo **OpenOrch**.

## Instalación (modo desarrollador)

1. Abre Edge y entra en `edge://extensions`.
2. Activa **Modo desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y elige esta carpeta (`OpenOrch Browser Extension`).
4. Abre OpenOrch → **Ajustes → Navegador**.
5. Copia el **código de conexión** y el puerto que aparecen ahí.
6. Pulsa el icono de **OpenOrch Browser** en Edge, pega el código y pulsa **Conectar**.
7. En OpenOrch elige el modo **Automático** (usa la extensión si está conectada) o **Extensión (Edge)**.

En Chrome es igual, desde `chrome://extensions`.

## Qué hace

- Abre pestañas dentro del grupo **OpenOrch** y las controla por CDP (`chrome.debugger`).
- Lee el árbol de accesibilidad, hace clic como un usuario real, escribe, selecciona, pulsa teclas, hace scroll y capturas.
- Si aparece un **CAPTCHA, login, 2FA o formulario de tarjeta**, el agente se detiene y te pide que lo resuelvas en la pestaña. Después continúa.
- Antes de pulsar un botón de **pago/compra** (`Pagar`, `Place order`, `Buy now`…), OpenOrch pide una confirmación aparte.
- Puedes **soltar las pestañas** desde el popup de la extensión (el agente perderá el control); para detener el turno usa el botón **Detener** de OpenOrch.

## Seguridad

- El puente escucha solo en `127.0.0.1` y exige un código de conexión.
- La extensión **solo** puede leer o actuar en pestañas del grupo `OpenOrch`. Las demás pestañas de tu navegador quedan fuera.
- El agente nunca recibe acceso a Node, al sistema de archivos ni a tus contraseñas. No rellena tarjetas ni contraseñas.
- No se resuelven CAPTCHAs automáticamente; los resuelve la persona.
- El código de conexión se guarda en el almacenamiento local de la extensión y en `data/browser-bridge.json` de OpenOrch.

## Notas

- Edge muestra un aviso de que la extensión está depurando el navegador mientras el agente usa CDP; es normal.
- Si cierras el grupo `OpenOrch`, el agente deja de tener pestañas y deberá abrir una nueva.
- Para distribuirla a otras personas habría que publicarla en Edge Add-ons/Chrome Web Store; para uso propio basta con cargarla descomprimida.
- Al cambiar el código de conexión en OpenOrch, vuelve a pegarlo aquí.
