
const pg = require("pg");

// Named parameters
const patchNamedParameters = require("./named_parameters").patchNamedParameters;

/**
 * Main database handler
 */
class Database {

    /**
     * 
     * @param {any} fastify The fastify instance
     * @param {any} logger The logger, usually fastify.log or fastify.log.child
     */
    constructor(fastify, { logger, pool, clientDecorator = "dbClient" }) {
        this.fastify = fastify;
        this.logger = logger;
        this.pool = pool;
        this.clientDecorator = clientDecorator;
    }

    /**
     * Registers the hooks which take care of releasing the database client when it has been sent
     */
    registerHooks() {
        // When the response has been sent, check if there is an active database client
        this.fastify.addHook("onSend", async (request) => {
            if (request[this.clientDecorator]) {
                this.logger.trace("Releasing DB client automatically on send");
                request[this.clientDecorator].release();
            }
        });

        // When the request errored, check if there is an active database client left
        this.fastify.addHook("onError", async (request) => {
            if (request[this.clientDecorator]) {
                this.logger.trace("Releasing DB client automatically on error");
                request[this.clientDecorator].release();
            }
        });
    }

    /**
     * Issues a new query on the pool without acquiring a client (async)
     * @param {string} text The sql query 
     * @param {object} params An object containing the named parameters, e.g. { id: 5 }
     * @returns {Promise<any>} The query result
     */
    async query(text, params) {
        const start = new Date().getTime();
        const result = await this.pool.query(text, params);
        this.logger.trace("Executed single query",
            { text, duration: new Date().getTime() - start, rows: result.rowCount });
        return result;
    }

    /**
     * Retrieves a new database client
     * @returns {Promise<pg.PoolClient>} The database client
     */
    async getClient() {
        this.logger.trace("Acquiring client");
        const client = await this.pool.connect();

        // The same client can be returned after it has been returned to the pool, so only
        // patch it once
        if (!client.patched) {
            this.logger.trace("Patching client");
            client.patched = true;
            this.patchClient(client);
        }

        // If there is still a query running, something really went nuts, because then the client
        // should not have been returned
        if (client.sanityTimeout) {
            this.logger.error("Client is busy and still got returned from pool");
            clearTimeout(client.sanityTimeout);
        }

        // Set a timeout of x seconds after which we will log this client's last query
        client.sanityTimeout = setTimeout(() => {
            this.logger.error("A client has been checked out for more than 5 seconds, forced release",
                { lastQuery: client.lastQuery, stillRunning: client.isQueryRunning });
            client.release();

            // If the apm (Application Performance Monitoring) plugin is available, send report
            if (this.fastify.apmTrackError) {
                this.fastify.apmTrackError("DB Client has been checked out for more than 5 seconds",
                    { lastQuery: client.lastQuery });
            }
        }, 15000);
        return client;
    }

    /**
     * Decorator to require a database client for the request
     * @returns {Function} decorator
     */
    requireDbClient() {
        return async (request) => {
            // Simply acquire a client under the given name
            request[this.clientDecorator] = await this.getClient();
        }
    }

    /**
     * Internal method to patch a datbase client, adding named parameters support and better error handling
     * @param {pg.PoolClient} client
     */
    patchClient(client) {

        // Add support for named parameters
        patchNamedParameters(client);

        // Patch the query method so that if it fails it will print an error first (and set the running flag)
        const db = this;
        const oldQueryMethod = client.query;
        client.query = async function (text, params) {
            db.logger.trace("Issuing query", { text, params });
            this.lastQuery = { text, params };
            this.isQueryRunning = true;
            try {
                const result = await oldQueryMethod.call(this, text, params);
                return result;
            } catch (err) {
                db.logger.error("Database query error", { error: err });
                throw err;
            } finally {
                this.isQueryRunning = false;
            }
        }

        // Patch the release method so we stop our sanity timeout
        const oldReleaseMethod = client.release;
        client.release = function () {
            db.logger.trace("Releasing client");

            // Clear our timeout and state which checks for unreleased clients
            client.isQueryRunning = false;
            if (client.sanityTimeout) {
                clearTimeout(client.sanityTimeout);
                client.sanityTimeout = null;
            }

            // Actually release
            return oldReleaseMethod.apply(client);
        }
    }


}


module.exports = {
    Database
};