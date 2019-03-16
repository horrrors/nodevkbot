const { vk: { token, version } } = require('./config.json')
const request = require('request-promise')
const fs = require('fs').promises;

//simple class for using api vk
class vkApi {
    constructor() {
        this.params = {
            'access_token': token, //access token for vk api
            'v': version           //version of api
        }
    }

    async method(name, args) {
        //method for request vk api
        return await request({
            uri: `https://api.vk.com/method/${name}`,
            qs: { ...this.params, ...args },
            json: true,
        })
    }

    async send(args) {
        //sending message to user
        await this.method('messages.send', args)
    }

    async attach(pic) {
        //attach photo to message
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
        //find access to first name of user
        const { response: [{ first_name }] } = await this.method('users.get', {
            user_ids: id
        })
        return first_name
    }
}

module.exports = vkApi