# fastify-postgres
Fastify plugin to easily use postgres databases. WIP, mostly used in my personal projects



## Usage

This is **not** an npm package! Simply include this repo into your module, add `pg` and `pg-native` and load the plugin:

```javascript

    fastify.register(require("./path_to_plugin.js"), {
        url: databaseString,
        maxConnections: 20
    });
```

