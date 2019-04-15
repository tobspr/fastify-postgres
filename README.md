# fastify-postgres
Fastify plugin to easily use postgres databases. WIP, mostly used in my personal projects

## Features

- Automatic handling of aquiring / releasing clients
- Named parameters (Modified from `node-postgres-named`),
- Tracking of unreleased clients (When a client stays open for more than 5 secs)


## Installation

This is **NOT** an npm package (I'm too lazy, feel free to make one)! Simply include this repo as a submodule into your module, add the required dependencies (`pg`, `pg-native` and `lodash`) and load the plugin:

```javascript

fastify.register(require("./path_to_submodule/plugin.js"), {
    url: "postgres://...",

    // Additional optional parameters and their defaults:
    maxConnections: 20,
    connectionTimeout: 5000,
    keepAlive: true,

    // How to decorate fastify, i.e. this results in fastify.database
    decoratorName: "database",

    // How to decorate the request object, by default the client will be available as "request.dbClient"
    requestDecoratorName: "dbClient"
});
```

## Usage 

It is highly recommended to use the decorators provided by this plugin. They will take care of aquiring / releasing the database client and decorate the request with a property `dbClient`.

```javascript
fastify.get("/", {

    // This takes care of populating request.dbClient
    preHandler: fastify.database.requireDbClient()

}, async (request, reply) => {

    // Issue query, named parameters are recommended
    const query = await request.dbClient.query(`
        select * from sometable where id = ~id
    `, { id: 5 });

    if (query.rowCount !== 1) {
        // Client will automatically be released
        reply.status(500);
        return;
    }

    // Same here, after the method returns the client will get released
    return {
        result: query.rows[0]
    }
});

```

### Transactions

Transactions are supported:


```javascript
fastify.get("/", {

    // This takes care of populating request.dbClient
    preHandler: fastify.database.requireDbClient()

}, async (request, reply) => {

    // Start transaction
    await request.dbClient.beginTransaction();

    // Issue query
    const query = await request.dbClient.query(`select * from sometable where id = ~id`, { id: 5 });

    // ...Do something ...
    
    // throw err("xxx);
    // ^ If an error is thrown anywhere in the handler, the transaction will be automatically
    // get a rollback and the client will get released


    // Commit transaction
    await request.dbClient.commitTransaction();

    // Again, client will automatically get released

});

```


### Custom usage

You can also use `async fastify.database.query(text, params)` and `async fastify.database.getClient()` and do stuff manually. Not recommended!



## Caveeats

- Calls `process.exit(-1)` if connection to database fails, probably throw an error instead, but for my projects its assumed that if the database is unavailable, the server is pretty useless
