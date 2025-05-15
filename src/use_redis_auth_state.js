// Dependencia necesaria: npm install redis
import { createClient } from 'redis';
import baileys from '@whiskeysockets/baileys';
const { initAuthCreds, proto } = baileys;

// Cliente Redis único (se puede reusar para todas las sesiones)
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
await redisClient.connect();  // Conecta al servidor Redis

/**
 * Hook de autenticación con Redis.
 * @param {string} sessionId - Identificador único de la sesión de WhatsApp.
 * @returns {Promise<{ state, saveCreds }>} Objeto con el estado de auth y función para guardar credenciales.
 */
async function useRedisAuthState(sessionId) {
  // Obtener credenciales almacenadas o inicializar nuevas si no existen
  const credsStr = await redisClient.hGet(sessionId, 'creds');
  const creds = credsStr ? JSON.parse(credsStr) : initAuthCreds();

  return {
    state: {
      creds,
      /** Métodos para obtener y guardar claves de cifrado en Redis **/
      keys: {
        /**
         * Lee múltiples claves de un tipo dado (e.g. 'pre-key', 'session') para ciertos IDs.
         */
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            const redisKey = `${type}-${id}`;
            let valueStr = await redisClient.hGet(sessionId, redisKey);
            if (valueStr) {
              // Reconstruir objeto/Buffer desde JSON
              let value = JSON.parse(valueStr);
              if (type === 'app-state-sync-key' && value) {
                // Reconstruir tipo proto Message.AppStateSyncKeyData
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            } else {
              data[id] = null;
            }
          }));
          return data;
        },
        /**
         * Guarda múltiples claves de distintos tipos en Redis. Elimina la entrada si el valor es nulo.
         */
        set: async (data) => {
          const pipeline = redisClient.multi();
          for (const category in data) {
            for (const id in data[category]) {
              const item = data[category][id];
              const redisKey = `${category}-${id}`;
              if (item) {
                // Serializar a JSON (conversión a base64 si contiene datos binarios)
                const valueStr = JSON.stringify(item);
                pipeline.hSet(sessionId, redisKey, valueStr);
              } else {
                pipeline.hDel(sessionId, redisKey);
              }
            }
          }
          await pipeline.exec();  // Ejecutar operaciones en lote
        }
      }
    },
    /** Guarda los credenciales actuales en Redis (ejecutar en cada actualización de creds) **/
    saveCreds: async () => {
      await redisClient.hSet(sessionId, 'creds', JSON.stringify(creds));
    }
  };
}

export { useRedisAuthState, redisClient };