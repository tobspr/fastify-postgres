
// @ts-ignore
const fastifyPlugin = require("fastify-plugin");
const Database = require("./database").Database;
let pg = require("pg");

// Use native if available
pg = pg.native || pg;

// Set Keepalive
pg.defaults.poolIdleTimeout = 600000; // 10 mins


// Main plugin
async function postgresDbConnector(fastify, options) {

    const decoratorName = options.decoratorName || "database";
    const requestDecorator = options.requestDecoratorName || "dbClient";

    const logger = fastify.log.child({ plugin: decoratorName });
    const pool = new pg.Pool({
        Client: pg.Client,
        connectionString: options.url,
        connectionTimeoutMillis: options.connectionTimeout || 5000,
        // ssl: true, // Not supported with pg-native
        keepAlive: options.keepAlive !== undefined ? options.keepAlive : true,
        max: options.maxConnections || 20
    });

    pool.on("error", (err, client) => {
        logger.error("Unexpected error on idle client:", { error: err.message });
    });

    logger.info("Connecting to database");
    let client = null;
    try {
        client = await pool.connect();
    } catch (err) {
        logger.error("Failed to connect:", { error: err });
        process.exit(-1);
        return;
    }
    client.release();

    const database = new Database(fastify, { logger, pool, requestDecorator });
    database.registerHooks();
    fastify.decorate(decoratorName, database);
}

module.exports = fastifyPlugin(postgresDbConnector);

