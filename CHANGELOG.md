# Cambios

Este archivo sigue el formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/), y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [1.1.1] - 2026-10-16

### Seguridad
- `yauzl` se actualizó de 3.2.0 a 3.4.0 por el aviso [GHSA-gmq8-994r-jv83](https://github.com/advisories/GHSA-gmq8-994r-jv83), un error de límite al leer archivos .zip. El Studio descomprime los .zip que recibe, así que conviene actualizar. Con esto, `npm audit` queda en 0 vulnerabilidades.

## [1.1.0] - 2026-10-16

### Agregado
- Primera versión pública, con licencia **Apache 2.0** (`LICENSE` y `NOTICE`).
- Firma de **Systech Soluciones**:
  - pie fijo en todas las pantallas y ventana "Acerca de";
  - encabezado en la terminal al arrancar;
  - firma al final de `verificacion.md`, `revision-independiente.md` y `ENTREGA.md`.
- Huellas SHA-256 en cada entrega:
  - `SHA256SUMS.txt` dentro del `.zip`, verificable con `sha256sum -c`;
  - la huella del `.zip` completo se ve en la pantalla de Entrega, se incluye en el informe copiado y se descarga como archivo `.sha256`.
- `SECURITY.md`, plantillas de issues y Release automática con `SHA256SUMS.txt` al crear un tag `v*`.

### Cambiado
- **.NET 10 (LTS)** por defecto: el agente lo usa en proyectos nuevos y el revisor lo controla. El `.devcontainer` instala el SDK 10.
- Tipografías alojadas en el propio repositorio (OFL 1.1). Ya no se usa Google Fonts, y la CSP queda en `font-src 'self'`: funciona sin internet y no comparte la IP del usuario.
- Instalación desde el repositorio propio: Code → Codespaces → Create codespace.

### Corregido
- En el Taller, mientras el agente corrige, la barra de pasos marca la verificación que falló en lugar de "Código generado".

## [1.0.0] - 2026-10-15

### Agregado
- Interfaz con tres pantallas: Nuevo trabajo, Taller y Entrega.
- Doble verificación: automática más revisión independiente con entorno limpio.
- Corrección automática, entrega en `.zip` y subida a GitHub.
