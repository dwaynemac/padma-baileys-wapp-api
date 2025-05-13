# Configuration

## ENVIRONMENT VARIABLES
- **PORT:** el puerto en que corre el server
- **LOG_LEVEL:** 'debug', 'info', 'warn'
- **DEVICE_NAME:** nombre del device en whatsapp al vincularlo

# Routes

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

## GET /sessions/:session_id/chats/:chat_id/messages
messages in chat

## GET /sessions/:session_id/chats/:chat_id/contact
Contact's details
