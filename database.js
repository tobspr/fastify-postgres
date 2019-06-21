
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
        this.fastify.addHook("onSend", async request => {
            const clients = request.dbClients;
            if (clients && clients.length > 0) {
                this.logger.trace("Releasing clients automatically on send", { amount: clients.length });
                for (let i = 0; i < clients.length; ++i) {
                    await clients[i].release();
                }
            }
            request.dbClients = [];
        });

        // When the request errored, check if there is an active database client left
        this.fastify.addHook("onError", async request => {
            const clients = request.dbClients;
            if (clients && clients.length > 0) {
                this.logger.trace("Releasing clients automatically on send", { amount: clients.length });
                for (let i = 0; i < clients.length; ++i) {
                    await clients[i].release();
                }
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
     * @returns {Promise<PoolClient>} The database client
     */
    async getClientUnsafe() {
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
            client.release();

            // If the apm (Application Performance Monitoring) plugin is available, send report
            if (this.fastify.apmTrackError) {
                this.fastify.apmTrackError("DB Client has been checked out for more than 25 seconds",
                    { lastQuery: client.lastQuery, stillRunning: client.isQueryRunning });
            } else {
                this.logger.error("A client has been checked out for more than 25 seconds, forced release",
                    { lastQuery: client.lastQuery, stillRunning: client.isQueryRunning, id: client.uniqueId });
            }
        }, 25000);
        return client;
    }

    /**
     * Decorator to require a database client for the request
     * @returns {Function} decorator
     */
    requireDbClient() {
        return async (request) => {
            // Simply acquire a client under the given name
            const client = await this.getClientUnsafe();
            request[this.requestDecorator] = client;

            if (this.fastify.addCleanupWork) {
                // Use the cleanup plugin
                this.fastify.addCleanupWork(request, async function () {
                    await client.release();
                }, "release-db-client");
            } else {
                // Cleanup plugin not installed, manually cleanup
                if (!request.dbClients) {
                    request.dbClients = [client];
                } else {
                    request.dbClients.push(client);
                }
            }
            return client;
        };
    }

    /**
     * Internal method to patch a datbase client, adding named parameters support and better error handling.
     * Needs to get called on every new client because pg-pool overrides the release method every time (meh)
     * @param {PoolClient} client
     */
    patchClient(client) {

        // this.logger.trace("Patching client", { id: client.uniqueId });

        // Add support for named parameters
        if (!client.namedParameters) {
            // this.logger.trace("Patching named parameters", { id: client.uniqueId });
            client.namedParameters = true;
            patchNamedParameters(client);
        }

        // Patch the query method so that if it fails it will print an error first (and set the running flag)
        const db = this;
        const oldQueryMethod = client.query;

        // @ts-ignore
        if (!oldQueryMethod.methodWasPatched_) {
            // this.logger.trace("Patching query method", { id: client.uniqueId });
            client.query = async function (text, params) {
                const trimmedText = text.replace(/[ \n\r\t]+/gi, " ").replace(/^\s+|\s+$/g, "");
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
            };
            // @ts-ignore
            client.query.methodWasPatched_ = true;
        }

        // Patch the release method so we stop our sanity timeout
        const oldReleaseMethod = client.release;
        // @ts-ignore
        if (!oldReleaseMethod.methodWasPatched_) {
            // this.logger.trace("Patching release method", { id: client.uniqueId });
            client.release = async function () {
                db.logger.trace("Releasing client", { id: this.uniqueId });

                await this.asyncTryRollback();

                // Clear our timeout and state which checks for unreleased clients
                this.isQueryRunning = false;
                if (this.sanityTimeout) {
                    clearTimeout(this.sanityTimeout);
                    this.sanityTimeout = null;
                }

                // Actually release
                return oldReleaseMethod.apply(this);
            };
            // @ts-ignore
            client.release.methodWasPatched_ = true;
        }

        // Patch the asyncBeginTransaction method
        const oldTransactionMethod = client.asyncBeginTransaction;
        // @ts-ignore
        if (!oldTransactionMethod || !oldTransactionMethod.methodWasPatched_) {
            // this.logger.trace("Patching asyncBeginTransaction Method", { id: client.uniqueId });
            client.asyncBeginTransaction = async function () {
                if (this.isWithinTransaction) {
                    db.logger.error("Tried to start transaction in transaction");
                    return false;
                }
                db.logger.trace("BEGIN <", this.uniqueId);
                this.isWithinTransaction = true;
                await this.query("begin");
                db.logger.trace("BEGIN < Done", this.uniqueId);
            };
            // @ts-ignore
            client.asyncBeginTransaction.methodWasPatched_ = true;
        }

        // Patch the asyncCommitTransaction method
        const oldCommitMethod = client.asyncCommitTransaction;
        // @ts-ignore
        if (!oldCommitMethod || !oldCommitMethod.methodWasPatched_) {
            // this.logger.trace("Patching asyncCommitTransaction Method", { id: client.uniqueId });
            client.asyncCommitTransaction = async function () {
                if (!this.isWithinTransaction) {
                    db.logger.error("Tried to commit transaction outside of transaction on client", this.uniqueId);
                    return false;
                }
                db.logger.trace("COMMIT <", this.uniqueId);
                // Note: Thsi must come before the async call!
                await this.query("commit");
                this.isWithinTransaction = false;
                db.logger.trace("COMMIT < Done", this.uniqueId);
            };
            // @ts-ignore
            client.asyncCommitTransaction.methodWasPatched_ = true;
        }

        // Patch the asyncTryRollback method
        const oldRollbackMethod = client.asyncTryRollback;
        // @ts-ignore
        if (!oldRollbackMethod || !oldRollbackMethod.methodWasPatched_) {
            // this.logger.trace("Patching asyncTryRollback Method", { id: client.uniqueId });
            client.asyncTryRollback = async function () {
                db.logger.trace("Called rollbackIfNotCommitted, within transaction = ", this.isWithinTransaction, "on client with id", this.uniqueId);
                if (this.isWithinTransaction) {
                    // Note: This must come before the async call!
                    db.logger.warn("ROLLBACK <", this.uniqueId);
                    this.isWithinTransaction = false;
                    await this.query("rollback");
                    db.logger.warn("ROLLBACK < Done", this.uniqueId);
                }
            };
            // @ts-ignore
            client.asyncTryRollback.methodWasPatched_ = true;
        }

    }

}

module.exports = {
    Database
};
