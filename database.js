
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
    constructor(fastify, { logger, pool, requestDecorator }) {
        this.fastify = fastify;
        this.logger = logger;
        this.pool = pool;
        this.requestDecorator = requestDecorator;
        this.clientIdCounter = 1;
    }

    /**
     * Registers the hooks which take care of releasing the database client when it has been sent
     */
    registerHooks() {
        // When the response has been sent, check if there is an active database client
        this.fastify.addHook("onSend", async (request) => {
            const clients = request.dbClients;
            if (clients && clients.length > 0) {
                this.logger.trace("Releasing clients automatically on send", { amount: clients.length });
                clients.forEach(client => client.release());
            }
            request.dbClients = [];
        });

        // When the request errored, check if there is an active database client left
        this.fastify.addHook("onError", async (request) => {
            const clients = request.dbClients;
            if (clients && clients.length > 0) {
                this.logger.trace("Releasing clients automatically on send", { amount: clients.length });
                clients.forEach(client => client.release());
            }
            request.dbClients = [];
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
        const client = await this.pool.connect();
        if (!client.uniqueId) {
            client.uniqueId = this.clientIdCounter++;
        }
        this.logger.trace("Acquired client", { id: client.uniqueId });

        this.patchClient(client);

        // If there is still a query running, something really went nuts, because then the client
        // should not have been returned
        if (client.sanityTimeout) {
            this.logger.error("Client is busy and still got returned from pool", { id: client.uniqueId });
            clearTimeout(client.sanityTimeout);
            client.sanityTimeout = null;
        }

        if (client.isQueryRunning) {
            this.logger.error("Client is running query and still got returned from pool", { id: client.uniqueId });
        }

        // Set a timeout of x seconds after which we will log this client's last query
        client.sanityTimeout = setTimeout(() => {
            this.logger.error("A client has been checked out for more than 5 seconds, forced release",
                { lastQuery: client.lastQuery, stillRunning: client.isQueryRunning, id: client.uniqueId });
            client.release();

            // If the apm (Application Performance Monitoring) plugin is available, send report
            if (this.fastify.apmTrackError) {
                this.fastify.apmTrackError("DB Client has been checked out for more than 5 seconds",
                    { lastQuery: client.lastQuery });
            }
        }, 5000);
        return client;
    }

    /**
     * Decorator to require a database client for the request
     * @returns {Function} decorator
     */
    requireDbClient() {
        return async (request) => {
            // Simply acquire a client under the given name
            const client = await this.getClient();
            request[this.requestDecorator] = client;
            if (!request.dbClients) {
                request.dbClients = [client];
            } else {
                request.dbClients.push(client);
            }

        }
    }

    /**
     * Internal method to patch a datbase client, adding named parameters support and better error handling.
     * Needs to get called on every new client because pg-pool overrides the release method every time (meh)
     * @param {pg.PoolClient} client
     */
    patchClient(client) {

        this.logger.trace("Patching client", { id: client.uniqueId });

        // Add support for named parameters
        if (!client.namedParameters) {
            this.logger.trace("Patching named parameters", { id: client.uniqueId });
            client.namedParameters = true;
            patchNamedParameters(client);
        }

        // Patch the query method so that if it fails it will print an error first (and set the running flag)
        const db = this;
        const oldQueryMethod = client.query;
        if (!oldQueryMethod.methodWasPatched_) {
            this.logger.trace("Patching query method", { id: client.uniqueId });
            client.query = async function (text, params) {
                const trimmedText = text.replace(/[ \n\r\t]+/gi, " ").replace(/^\s+|\s+$/g, "");
                // db.logger.trace("Issuing query", { text: trimmedText, params });
                this.lastQuery = { text: trimmedText, params };
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
            client.query.methodWasPatched_ = true;
        }

        // Patch the release method so we stop our sanity timeout

        const oldReleaseMethod = client.release;
        if (!oldReleaseMethod.methodWasPatched_) {
            this.logger.trace("Patching release method", { id: client.uniqueId });
            client.release = function () {
                db.logger.trace("Releasing client", { id: this.uniqueId });

                // Clear our timeout and state which checks for unreleased clients
                this.isQueryRunning = false;
                if (this.sanityTimeout) {
                    clearTimeout(this.sanityTimeout);
                    this.sanityTimeout = null;
                }

                // Actually release
                return oldReleaseMethod.apply(this);
            }
            client.release.methodWasPatched_ = true;
        }
    }


}


module.exports = {
    Database
};