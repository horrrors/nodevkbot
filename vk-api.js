const { vk: { token, version } } = require('./config.json')
const request = require('request-promise')
const fs = require('fs').promises;


class vkApi {
    constructor() {
        this.params = {
            'access_token': token, //токен доступа вконтакте
            'v': version           //версия API вконтакте
        }
    }

    async method(name, args) {
        //метод, позволяющий использовать большинство api вконтакте
        return await request({
            uri: `https://api.vk.com/method/${name}`,
            qs: { ...this.params, ...args },
            json: true,
        })
    }

    async send(args) {
        //Отправляет сообщение исходя из переданных параметров
        await this.method('messages.send', args)
    }

    async attach(pic) {
        //Прикрепляет изображение к сообщению
        const { response: { upload_url } } = await this.method('photos.getMessagesUploadServer')
        const upload = await request({
            method: 'POST',
            uri: upload_url,
            formData: {
                photo: {
                    value: await fs.readFile(pic),
                    options: {
                        filename: pic,
                        contentType: 'image/jpeg'
                    }
                }
            },
            json: true
        })
        const { response: [{ owner_id, id }] } = await this.method('photos.saveMessagesPhoto', upload)
        return `photo${owner_id}_${id}`
    }

    async getUser(id) {
        //быстрый доступ к имени пользователя по айди пользователя
        const { response: [{ first_name }] } = await this.method('users.get', {
            user_ids: id
        })
        return first_name
    }
}

module.exports = vkApi