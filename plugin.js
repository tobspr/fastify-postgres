
import { Database } from "./database";

const fastifyPlugin = require("fastify-plugin");
let pg = require("pg");

// Use native if available
pg = pg.native || pg;

// Set Keepalive
pg.defaults.poolIdleTimeout = 60000; // 1 mins

// Main plugin
async function postgresDbConnector(fastify, options) {

    const decoratorName = options.decoratorName || "database";
    const requestDecorator = options.requestDecoratorName || "dbClient";

    const logger = fastify.log.child({ plugin: decoratorName });

    const pool = new pg.Pool({
        // @ts-ignore
        Client: pg.Client,
        // @ts-ignore
        client: pg.Client,
        connectionString: options.url,
        connectionTimeoutMillis: options.connectionTimeout || 5000,
        
        
        ssl: !!(pg === pg.native), // Not supported with pg-native

        keepAlive: options.keepAlive !== undefined ? options.keepAlive : true,
        max: options.maxConnections || 20,

        application_name: options.appName || "fastify-postgres"
    });

    pool.on("error", (err) => {
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
    await client.release();

    const database = new Database(fastify, { logger, pool, requestDecorator, timeoutMs: options.timeoutMs });
    database.registerHooks();
    fastify.decorate(decoratorName, database);
}

module.exports = fastifyPlugin(postgresDbConnector);
