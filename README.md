This is chat bot based on callback api Vk.

I wanted to simplify life of usual students AGPU, 90% which use mobile for checking their schedule. 
I did not think of anything better than chat-bot vk.com

This bot can:
1) Save screenshots in database as archive
2) send to students screenshot their schedule from archive or make new
3)Every sunday sending to students screenshot their next week schedule
4)Cheking for updates in schedule and notify student about this

Technology which was used:
api vk and callback api 
postgres as database
fastify as http server
puppeteer for create screenshots
knex for query build
cron for repeating tasks
async/await

at the time of writing this text was about ~500 subscribers for this project
link: https://vk.com/public163219012
