# Política de seguridad

## Cómo reportar un problema de seguridad

**No abras un issue público.** Los issues son visibles para todo el mundo y un problema de seguridad publicado antes de corregirse pone en riesgo a quienes usan SYSTECH Studio.

Escribí a **systechsolucionez@gmail.com** con el asunto `SEGURIDAD - SYSTECH Studio` e incluí:

- la versión (la ves en el pie de la interfaz o en el "Acerca de");
- qué encontraste y qué impacto puede tener;
- los pasos para reproducirlo (un ejemplo mínimo alcanza);
- si querés que te mencionemos en el CHANGELOG cuando se publique la corrección.

Respondemos dentro de los 7 días. Te mantenemos al tanto mientras lo corregimos y coordinamos con vos cuándo se publica.

## Versiones con soporte

| Versión | Recibe correcciones de seguridad |
|---|---|
| 1.1.x | Sí |
| < 1.1 | No |

## Alcance

Están dentro del alcance los problemas en el código de este repositorio, por ejemplo:

- ejecución de comandos o lectura de archivos fuera de la carpeta del trabajo;
- *zip slip* o *zip bomb* que eviten los controles;
- filtración de la API key o del token de GitHub hacia el código del cliente o hacia la consola;
- XSS, CSRF o *DNS rebinding* contra la interfaz;
- que el `.zip` entregado incluya secretos o archivos excluidos.

Quedan fuera los problemas propios de Claude Code, de GitHub Codespaces o de las dependencias. Esos se reportan a sus responsables, aunque igual nos interesa saberlo.

## Recordatorio de uso seguro

SYSTECH Studio compila y ejecuta el código de los proyectos que procesa. Usalo solo con proyectos en los que confíes, con tu propia API key, con un tope de gasto y con el puerto en modo **Private**.
