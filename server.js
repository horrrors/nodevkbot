server = require("fastify")({ logger: true });
const knex = require("knex");
const puppeteer = require('puppeteer');

(async () => {
    try {
        //create object of browser for ram economy
        const browser = await puppeteer.launch(
            {
                args: ['--no-sandbox',
                    '--disable-setuid-sandbox']
            });

            server.decorate('browser', browser)    
            server.decorate('knex', knex);
            server.route(require("./main-route"));

        await server.listen(process.env.PORT || 5000, '0.0.0.0')
    } catch (err) {
        console.log(err)
    }
})();
