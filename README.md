A minimal WhatsApp‐API‑like HTTP server using Baileys

En la implementación actual, la API utiliza la librería Baileys para conectarse a WhatsApp y manejar sesiones. Esto se observa en el archivo helpers.js, donde se crea un socket de Baileys y un store en memoria para cada sesión iniciada ￼. El store de Baileys mantiene en caché los datos de WhatsApp (chats, mensajes, contactos, etc.) y se vincula al socket mediante store.bind(sock.ev), de forma que todos los eventos y datos (p. ej. lista de chats) queden almacenados automáticamente. Además, las sesiones activas se administran en un mapa (sessions) que asocia un sessionId con su correspondiente sock (conexión Baileys) y store. Cada endpoint REST accede a la sesión correspondiente mediante el middleware requireSession, obteniendo así req.session.sock y req.session.store para interactuar con WhatsApp.

# RUN
Run ```docker-compose up```

# Configuration

## Server ENVironment variables
- **API_KEY:** api key para acceder
- **PORT:** el puerto en que corre el server
- **LOG_LEVEL:** 'debug', 'info', 'warn'
- **DEVICE_NAME:** nombre del device en whatsapp al vincularlo
- **REDIS_URL:** url de redis

## REDIS
Redis should be available at **REDIS_URL**.

# == Server endpoints ==

## GET /
server check

## GET /sessions
lists all active sessions

## POST /sessions/:id
starts or resumes a session

## GET /sessions/:id
returns information about a specific session

## DELETE /sessions/:id
logs out & removes session dir

## GET /sessions/:session_id/chats
list all chats

## GET /sessions/:session_id/chats/:chat_id
details of given chat

## PUT /sessions/:session_id/chats/refresh
refreshes chat history

## GET /sessions/:session_id/chats/:chat_id/messages
messages in chat

## GET /sessions/:session_id/chats/:chat_id/contact
Contact's details

## POST /sessions/:session_id/chats/:chat_id/messages
Sends a new message to a chat. Requires a JSON body with a `text` field containing the message to send.

Example request body:
```json
{
  "text": "Hello, this is a test message"
}
```

Returns the message ID, timestamp, and the message text.
