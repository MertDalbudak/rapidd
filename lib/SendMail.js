const NODE_ENV = process.env.NODE_ENV;

const nodeMailer = require('nodemailer');
const {emails} = require("../config/app.json");

class SendMail{
    constructor(from, recipient, subject, message, attachments, callback) {
        // VALIDATE INPUT & SET
        if(this.validateInput(from))
            return false;

        const transporter = nodeMailer.createTransport({
            host: this.from['host'],
            port: this.from['port'],
            secure: this.from['secure'],
            auth: {
                user: this.from['user'],
                pass: this.from['password']
            },
            tls: {
                rejectUnauthorized: false
            }
        });
        const mailOptions = {
            to: recipient,
            subject: subject,
            html: message,
            attachments: attachments
        };
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log(error);
                callback(false);
            } else
                callback(true);
        });
    }
    validateInput(from){
        // VALIDATE from
        if(typeof from !== 'string')
            throw `First parameter must be typeof string, ${typeof from} given`;
        else {
            if(emails.hasOwnProperty(from) == false)
                throw `${from} is not a defined email connection`;
        }
        this.from = emails[from];
    }
}

module.exports = SendMail;