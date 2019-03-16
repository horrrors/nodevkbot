const { knex, browser } = server
const Bot = require('./bot')
const bot = new Bot(browser)

const route = {}
route.method = 'POST'
route.url = '/'

route.handler = async (req, res) => {
    const { body } = req
    console.log(body)
    await bot.handler(body)

    res.status(200).send('ok')
}

module.exports = route