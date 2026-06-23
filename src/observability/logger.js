const pino = require("pino");

const level = process.env.VENOM_LOG_LEVEL || "info";
const transport =
  process.env.VENOM_LOG_PRETTY === "true"
    ? pino.transport({ target: "pino-pretty" })
    : undefined;

module.exports = pino({
  level,
  transport,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "body.apiKey",
      "body.secret",
      "body.privateKey",
    ],
  },
});
