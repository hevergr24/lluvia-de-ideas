# Mi Melodía MX

Plataforma en español para entregar canciones personalizadas con códigos de un solo uso. Incluye panel de agencia, canje de códigos, generador local de dedicatorias, subida de portada y audio, páginas públicas con reproductor móvil y vista previa Open Graph.

## Requisitos

- Node.js 18 o posterior (recomendado Node 20 LTS).
- npm.

La aplicación usa **SQLite y archivos locales** (alternativa autocontenida a Supabase): no necesita claves, cuenta de base de datos ni API de IA. La base `data.sqlite` y los archivos subidos se crean durante el primer arranque.

## Ejecutar en local

```bash
cd codigos-canciones
npm install
npm start
```

Abre [http://localhost:3000](http://localhost:3000). El primer arranque inicializa la base e inserta el código de prueba `MELODIA-DEMO-2026`.

### Probar el recorrido completo

1. En la página de inicio, pulsa **MELODIA-DEMO-2026** para rellenar el formulario, escribe un nombre y canjea el código. El código pasa a estado utilizado al canjearse, así que no se puede volver a utilizar.
2. En la página de creación, escribe título, nombre de la persona y dedicatoria; opcionalmente pide un borrador indicando una ocasión o idea. El generador usa plantillas incluidas en el proyecto, sin servicios externos.
3. Elige una portada JPG/PNG/WEBP y un audio MP3/WAV/M4A de hasta 20 MB. Crea y abre el enlace generado en `/c/<id>`.
4. Abre `/admin` e inicia sesión con la contraseña inicial `melodia2026`. Genera códigos (1–500 por lote), revisa estados/cliente/fecha, desactiva códigos sin usar y descarga el CSV.

### Configuración de la contraseña

La contraseña se almacena como hash scrypt con sal aleatoria en la tabla local `settings`; no se guarda como texto. Para elegir la contraseña inicial propia, define `ADMIN_PASSWORD` **antes del primer inicio**:

```bash
ADMIN_PASSWORD='una-clave-segura' npm start
```

Si ya existe `data.sqlite`, cambiar la variable no reemplaza el hash guardado. Para un entorno nuevo, inicia con `ADMIN_PASSWORD` definido. Cambia también el código demo o elimínalo antes de poner el servicio en producción.

Variables disponibles:

- `PORT`: puerto HTTP, predeterminado `3000`.
- `DB_PATH`: ruta alternativa para SQLite.
- `ADMIN_PASSWORD`: contraseña inicial, solo se toma al crear los ajustes por primera vez.

## Despliegue posterior

No se ha desplegado esta aplicación ni se incluye un dominio público. Para alojarla en un servidor Node compatible:

1. Sube este proyecto e instala dependencias con `npm ci` (o `npm install` si no existe `package-lock.json`). Ejecuta `npm start`.
2. Configura `PORT` según el proveedor y define `ADMIN_PASSWORD` para la primera inicialización.
3. Monta un **volumen persistente** para `data.sqlite` y la carpeta `public/uploads` (o ajusta `DB_PATH` y la ruta de archivos en `app.js`). Sin almacenamiento persistente se perderán códigos, canciones y medios al reiniciar o reconstruir el contenedor.
4. Usa HTTPS detrás de un proxy y limita el acceso al panel. Haz respaldos de la base y de las subidas juntos: ambos se necesitan para recuperar páginas.
5. Antes de compartir códigos reales, elimina o marca como desactivado el código demo y verifica los límites/retención de archivos del proveedor.

Para publicar enlaces desde otro dominio, sirve la aplicación bajo el dominio final. Las etiquetas OG se generan en el servidor en `/c/:id` y apuntan a la portada absoluta de esa petición; no requieren JavaScript para que WhatsApp lea título, descripción e imagen. Algunas plataformas pueden guardar la vista previa en caché.

## Comportamiento y límites

- Los códigos nuevos tienen formato `MELODIA-XXXX-XXXX` y se generan aleatoriamente; el código demo es `MELODIA-DEMO-2026`.
- Cada código solo puede canjearse una vez. El canje marca su estado como utilizado inmediatamente; si alguien abandona antes de guardar su canción, ese código sigue consumido.
- El panel está pensado para un administrador sencillo. Las sesiones se mantienen en memoria durante 12 horas y finalizan al reiniciar el proceso.
- Las páginas y los archivos se guardan localmente, sin caducidad automática ni borrado desde la interfaz. En producción, protege el servidor, respalda los archivos y añade una política de privacidad/retención adecuada.
- El generador de texto ofrece borradores por palabras clave (cumpleaños, XV años, aniversario, boda, amor, amistad y agradecimiento); es una función local basada en plantillas, no un modelo de IA.
- Contacto de WhatsApp del pie de página es un marcador sustituible (`+52 1 000 000 0000`) en `app.js`.

## Estructura

```text
app.js                 API, SQLite, validación, subida y Open Graph
public/index.html       Canje del código
public/crear.html       Creación de la página y dedicatoria
public/admin.html       Panel de códigos
public/styles.css       Estilos adaptables y reproductor oscuro
public/player.js        Reproducción, progreso y búsqueda de posición
public/uploads/         Portadas y audios subidos (se crea automáticamente)
data.sqlite            Base de datos local (se crea automáticamente)
```
