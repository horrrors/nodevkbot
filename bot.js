const vkApi = require('./vk-api');
const CronJob = require('cron').CronJob;
const { parseUrl, keyboard, button, fastKeyboards, fastButtons, fastStrings, weatherApi: { weatherUrl, weatherKey, weatherText } } = require('./config.json')
const fs = require('fs').promises;
const difflib = require('difflib');
const request = require('request-promise');
var HTMLParser = require('node-html-parser');

const knex = require('knex')({
    client: 'pg',
    connection: process.env.HEROKU_POSTGRESQL_GRAY_URL,
});

//Метод форматирования строк в Python-style
String.prototype.format = function () {
    var args = arguments;
    return this.replace(/\{(\d+)\}/g, function (m, n) {
        return args[n] ? args[n] : m;
    });
};

//Метод форматирования строк, возвращает исходную строку, в которой первый символ в верхнем регистре, остальные в нижнем
String.prototype.capitalize = function () {
    return this.charAt(0).toUpperCase() + this.slice(1).toLowerCase();
}

//Метод массива, возвращает случайный элемент из массива
Array.prototype.randomElement = function () {
    return this[Math.floor(Math.random() * this.length)]
}




class Bot {
    constructor(browser) {
        this.vk = new vkApi()
        this.browser = browser
        this.suggests()
        this.suggest = []

        //Каждую полночь обновляет архив скриншотов
        new CronJob({
            cronTime: '00 00 00 * * *',
            onTick: this.screenEveryDay.bind(this),
            timeZone: 'Europe/Moscow'
        }).start();

        //Каждую субботу в час дня переводит время расписания на следующую неделю
        new CronJob({
            cronTime: '00 00 13 * * 6',
            onTick: this.updateWeek.bind(this),
            timeZone: 'Europe/Moscow'
        }).start();

        //Каждые пять часов проверяет изменения в расписаниях студентов, кроме субботы.
        new CronJob({
            cronTime: '00 00 */5 * * 0-5',
            onTick: this.compareHtml.bind(this),
            timeZone: 'Europe/Moscow',
        }).start();
        
        //Каждое воскресенье в 9 утра присылает новое расписание и прогноз
        new CronJob({
            cronTime: '00 00 9 * * 0',
            onTick: this.everyWeek.bind(this),
            timeZone: 'Europe/Moscow',
        }).start();

    }

    //рекурсивная функция для чтения пересланных сообщений
    _readFwd([{ text, fwd_messages }]) {
        return !fwd_messages ? text : this._readFwd(fwd_messages)

    }

    //удаляет обращение к боту в беседах
    _appeal(message) {
        return message.replace(/\[[a-z0-9|@]+]\s/, '')
    }

    //Присылает зарегистрированному пользователю стандартную клавиатуру
    async _defaultKeyboard(id) {
        if (! await this.isReg(id)) return
        return JSON.stringify(fastKeyboards.main)
    }

    //Создает скриншот расписания группы, которая передается в аргументах
    async _makeScreen(group, groupID, type, data) {
        const page = await this.browser.newPage();
        await page.goto(parseUrl.format(groupID, group, type, data));
        await page.setViewport({
            width: 1540,
            height: 1150
        });
        const boxes = await page.$('.tab-pane');
        await boxes.screenshot({ path: `${group}.png`, });
        await page.close();

    }


    //Собирает все названия, по которым можно получить расписание, используется для подсказок при ошибках ввода
    suggests() {
        knex('ids').select('name').then(function (obj) { this.suggest = obj.map(sug => sug.name.toLowerCase()); }.bind(this))
    }

    //Проверяет, есть ли у пользователя регистрация 
    async isReg(id) {
        return (await knex('rassilka').where('id', id)).length > 0
    }

    //Проверяет, подписан ли пользователь на еженедельную рассылку
    async isDispatch(id) {
        return (await knex('rassilka').first('dispatch').where('id', id)).dispatch
    }

    //Проверяет, подписан ли пользователь на уведомления об изменениях в его расписании
    async isChanges(id) {
        return (await knex('rassilka').first('changes').where('id', id)).changes
    }

    //Возвращает текущий номер недели на сайте с расписанием
    async getCurDate() {
        const { bddata, number } = await knex('dates')
            .first('bddata', 'number')
            .where('name', 'bddatanow')
        return number
    }

    //Обновляет номер недели, запускает функцию обновления архива скриншотов
    async updateWeek() {
        await knex('dates').update('number', await this.getCurDate() + 1).where('name', 'bddatanow')
        await this.screenEveryDay()
    }

    //Делает скриншот и записывает его бинарный вид в базу
    async screenIntoBd(group, id, type) {
        await this._makeScreen(group, id, type, await this.getCurDate())
        await knex('ids').update('bytes', await fs.readFile(`${group}.png`)).where('name', group)
    }

    //Отправляет пользователю запрошенное расписание, в случае ошибки переадрессует дальше
    async sendFromBd(id, message, text) {
        try {
            const { bytes } = await knex('ids').first('bytes').where('name', message)
            await fs.writeFile(`${message}.png`, bytes)
            const username = await this.vk.getUser(id)
            this.vk.send({
                peer_id: id,
                message: !text ? (fastStrings.complete.randomElement()).format(username) : text.format(await this.forecast()),
                attachment: await this.vk.attach(`${message}.png`),
                keyboard: await this._defaultKeyboard(id)
            })
        } catch (error) {
            await this.sendOtherWeeks(id, message)
        }

    }

     //Еженедельная рассылка
     async everyWeek() {
        for (const { id: userID, grupa } of await knex('rassilka').select('id', 'grupa').where('dispatch', true)) {
            // const { id: groupID, type } = await knex('ids').first('id', 'type', 'html').where('name', grupa)
            await this.sendFromBd(userID, grupa, fastStrings.dispatch)
        }
    }

    //Отправляет пользователю скриншот расписания недели по сдвигу, который он указал, например Вм-ивт-4-1 +1 
    async sendOtherWeeks(id, message) {
        const [group, changer] = message.split(' ')
        const digit = parseInt(changer)
        if (Number.isInteger(digit)) {
            await this.deliveryScreenshot(id, group, await this.getCurDate() + digit)
        } else await this.makeError(id, message)
    }

    //Составляет пользователю сообщение об ошибке, старается подобрать похожие имена
    async makeError(id, message) {
        let localSuggest = difflib.getCloseMatches(message.toLowerCase(), this.suggest, 5, 0.4)
        localSuggest = localSuggest.map(sug => sug.capitalize()).join('\n')
        console.log(localSuggest.length)
        await this.vk.send({
            peer_id: id,
            message: (fastStrings.sorry.randomElement()).format(localSuggest.length > 0 ? localSuggest : "Не нашел совпадений :("),
            keyboard: await this._defaultKeyboard(id)
        })
    }

    //Создает новый скриншот расписания
    async deliveryScreenshot(id, grupa, data) {
        if (!data) data = await this.getCurDate()
        const username = await this.vk.getUser(id)
        const { id: groupID, type } = await knex('ids').first().where('name', grupa)
        await this._makeScreen(grupa, groupID, type, data)
        this.vk.send({
            peer_id: id,
            message: (fastStrings.complete.randomElement()).format(username),
            attachment: await this.vk.attach(`${grupa}.png`),
            keyboard: await this._defaultKeyboard(id)
        })
    }

    //Отправляет зарегистрированному пользователю расписание группы, под которой он зарегистрирован
    async sendMyRasp(id) {
        if (! await this.isReg(id)) {
            this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        }
        const { grupa } = await knex('rassilka').first('grupa').where('id', id)
        await this.sendFromBd(id, grupa)
    }

    //Отправляет зарегистрированному пользователю обновленное расписание его группы
    async sendNew(id) {
        if (! await this.isReg(id)) {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        }
        const { grupa } = await knex('rassilka').first('grupa').where('id', id)
        await this.deliveryScreenshot(id, grupa)
    }

    //Функция для архивации скриншотов всех названий в базе
    async screenEveryDay() {
        for (const { name, id, type } of await knex('ids').select()) {
            this.makeHtml(name, id, type)
            await this.screenIntoBd(name, id, type)
        }
    }

    //Регистрирует пользователя под его группой
    async regUser(id, message) {
        const grupa = message.split(' ')[1].capitalize()

        if (!await this.isReg(id)) {

            if ((await knex('rassilka').where('grupa', grupa)).length > 0) {
                await knex('rassilka').insert({ id, grupa })
                await this.vk.send({
                    peer_id: id,
                    message: fastStrings.reg,
                    keyboard: await this._defaultKeyboard(id)
                })
            } else {
                await this.vk.send({
                    peer_id: id,
                    message: fastStrings.regSorry,
                    keyboard: await this._defaultKeyboard(id)
                })
            }
        } else {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.regAgain,
                keyboard: await this._defaultKeyboard(id)
            })
        }
    }

    //Удаляет пользователя из бд
    async deleteRegistration(id) {
        await knex('rassilka').where('id', id).del()
        this.vk.send({
            peer_id: id,
            message: fastStrings.unreg,
            keyboard: JSON.stringify(keyboard)
        })
    }

    //Присылает зарегистрированному пользователю клавиатуру с настройками
    async sendSettingsKeyboard(id) {
        if (! await this.isReg(id)) return

        const localKeyboard = JSON.parse(JSON.stringify(keyboard))

        localKeyboard['buttons'].push(
            await this.isDispatch(id) ? fastButtons['dispatchFalse'] : fastButtons['dispatchTrue'],
            await this.isChanges(id) ? fastButtons['changesFalse'] : fastButtons['changesTrue'],
            fastButtons['unreg'],
            fastButtons['back'])

        const { grupa } = await knex('rassilka').first('grupa').where('id', id)

        await this.vk.send({
            peer_id: id,
            message: `&#13;`,
            keyboard: JSON.stringify(localKeyboard)
        })

    }

    //Присылает зарегистрированному пользователю клавиатуру с выбором недель отличных от текущей
    async sendOtherWeeksKeyboard(id) {
        if (! await this.isReg(id)) return

        const localKeyboard = JSON.parse(JSON.stringify(keyboard))
        localKeyboard['one_time'] = false
        const { grupa } = await knex('rassilka').first('grupa').where('id', id)
        const group = `${grupa} {0}`

        for (const i of [1, 2, -1, -2]) {
            let localButton = JSON.parse(JSON.stringify(button))
            localButton['action']['label'] = group.format(i < 0 ? i : `+${i}`)
            localKeyboard['buttons'].push([localButton])
        }
        localKeyboard['buttons'].push(fastButtons['back'])

        await this.vk.send({
            peer_id: id,
            message: await this.forecast(),
            keyboard: JSON.stringify(localKeyboard)
        })
    }

    //Присылает зарегистрированному пользователю стандартную клавиатуру
    async sendDefaultKeyboard(id) {
        await this.vk.send({
            peer_id: id,
            message: "&#13;",
            keyboard: await this._defaultKeyboard(id)
        })
    }

    //Подписывает на еженедельную рассылку
    async dispatchTrue(id) {
        if (! await this.isReg(id)) {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        } else {
            await knex('rassilka').update('dispatch', true).where('id', id)
            await this.vk.send({
                peer_id: id,
                message: fastStrings.regDisp,
                keyboard: await this.sendSettingsKeyboard(id)
            })
        }
    }

    //Отписывает от еженедельной рассылки
    async dispatchFalse(id) {
        if (! await this.isReg(id)) {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        } else {
            await knex('rassilka').update('dispatch', false).where('id', id)
            await this.vk.send({
                peer_id: id,
                message: fastStrings.unregDisp,
                keyboard: await this.sendSettingsKeyboard(id)
            })
        }
    }

    //Подписывает на уведомления об изменениях в расписании
    async changesTrue(id) {
        if (! await this.isReg(id)) {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        } else {
            await knex('rassilka').update('changes', true).where('id', id)
            await this.vk.send({
                peer_id: id,
                message: fastStrings.regChanges,
                keyboard: await this.sendSettingsKeyboard(id)
            })
        }
    }

    //Отпсиывает от уведомлений об изменениях в расписании
    async changesFalse(id) {
        if (! await this.isReg(id)) {
            await this.vk.send({
                peer_id: id,
                message: fastStrings.permissions,
                keyboard: JSON.stringify(keyboard)
            })
            return
        } else {
            await knex('rassilka').update('changes', false).where('id', id)
            await this.vk.send({
                peer_id: id,
                message: fastStrings.unregChanges,
                keyboard: await this.sendSettingsKeyboard(id)
            })

        }
    }

    //Обновляет в базе hmtl группы
    async makeHtml(group, id, type) {
        const html = await this.requestHtml(id, group, type, await this.getCurDate())
        await knex('ids').update('html', html).where('name', group)
    }

    //Возвращает Html расписания запрошенной группы
    async requestHtml(Searchid, SearchString, Type, Weekid) {
        return HTMLParser.parse(await request({
            uri: 'http://www.it-institut.ru/Raspisanie/SearchedRaspisanie',
            qs: {
                Ownerid: 118,
                Searchid,
                SearchString,
                Type,
                Weekid
            }
        })).querySelector('.table').structuredText
    }

    //Сравнивает изменения в расписании пользователей
    async compareHtml() {
        const changed = {}

        for (const { id: userID, grupa } of await knex('rassilka').select('id', 'grupa').where('changes', true)) {
            const { id: groupID, type, html } = await knex('ids').first('id', 'type', 'html').where('name', grupa)

            const newHtml = grupa in changed ? changed[grupa] : await this.requestHtml(groupID, grupa, type, await this.getCurDate())

            if (html != newHtml) {
                await this.vk.send({
                    peer_id: userID,
                    message: fastStrings.changes,
                    keyboard: await this._defaultKeyboard(userID)
                })
                changed[grupa] = newHtml
            }
        }

        for (const key in changed)
            await knex('ids').update('html', changed[key]).where('name', key)
    }

    //Составляет прогноз погоды для студентов Армавирского Государственного Педагогического Университета :)
    async forecast() {
        const response = await request({
            uri: weatherUrl,
            qs: {
                key: weatherKey,
                q: "Армавир",
                lang: 'ru',
                days: 3
            },
            json: true
        })

        const { current: { temp_c: now, condition: { text: textNow } } } = response
        const { forecast: { forecastday: [today, tomorrow, afterTomorrow] } } = response

        return weatherText.format(
            +Math.floor(now), textNow.toLowerCase(),
            +Math.floor(today.day.mintemp_c), +Math.floor(today.day.maxtemp_c), today.day.condition.text.toLowerCase(),
            +Math.floor(tomorrow.day.mintemp_c), +Math.floor(tomorrow.day.maxtemp_c), tomorrow.day.condition.text.toLowerCase(),
            +Math.floor(afterTomorrow.day.mintemp_c), +Math.floor(afterTomorrow.day.maxtemp_c), afterTomorrow.day.condition.text.toLowerCase(),
        )
    }

    //Является ли сообщение милым
    isCute(message) {
        const cuteList = ["❤", "💜", "🖤", "Спасибо", "спасибо"]
        for (const ohCute of cuteList) if (message.indexOf(ohCute) != -1) return true
        return false
    }

    //милый ответ
    async sendCute(peer_id) {
        await this.vk.send({
            peer_id,
            message: "[horrrs|Мише] будет приятно\n🖤",
            keyboard: await this._defaultKeyboard(peer_id)
        })
    }

    //Получает личное сообщение и выбирает необходимый путь обработки
    async handler({ object: { peer_id, text, fwd_messages } }) {
        const message = fwd_messages.length ? this._readFwd(fwd_messages).capitalize() : text.capitalize()

        if (message == 'Обновить расписание')
            this.sendNew(peer_id)

        else if (message == 'Расписание')
            this.sendMyRasp(peer_id)

        else if (message == 'Назад')
            this.sendDefaultKeyboard(peer_id)

        else if (message == 'Настройки')
            this.sendSettingsKeyboard(peer_id)

        else if (message == 'Другие недели')
            this.sendOtherWeeksKeyboard(peer_id)

        else if (message == 'Обнулить регистрацию')
            this.deleteRegistration(peer_id)

        else if (message.startsWith('Регистрация'))
            this.regUser(peer_id, message)

        else if (message == 'Подписаться на изменения')
            this.changesTrue(peer_id)

        else if (message == 'Отписаться от изменений')
            this.changesFalse(peer_id)

        else if (message == 'Подписаться на рассылку')
            this.dispatchTrue(peer_id)

        else if (message == 'Отписаться от рассылки')
            this.dispatchFalse(peer_id)
        
        else if (this.isCute(message))
            this.sendCute(peer_id)

        else
            this.sendFromBd(peer_id, message)
    }
}

module.exports = Bot










