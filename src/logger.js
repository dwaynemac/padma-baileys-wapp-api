import P from 'pino'
export default P({ level: process.env.LOG_LEVEL || 'debug'})