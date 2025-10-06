const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {ejsRender} = require('../../lib/ejsRender');
const eMail = require('../../lib/SendMail');
const {RestApi} = require('../../lib/RestApi')
const {Model, QueryBuilder, prisma} = require('../Model');
const pushLog = require('../../lib/pushLog');

const Renderer = new ejsRender();

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || 10);

class User extends Model {
    constructor(options){
        super('user', options);
    }

    /**
     * @param {string} q 
     * @property {string|Object} include 
     * @param {number} limit 
     * @param {number} offset 
     * @param {string} sortBy 
     * @param {'asc'|'desc'} sortOrder  
     * @returns {Object[]}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    /**
     * @param {number} id 
     * @param {string | Object} include 
     * @returns {{} | null}
     */
    async get(id, include){
        return await this._get(Number(id), include);
    }

    /**
     * @param {string} email 
     * @param {string | Object} include 
     * @returns {{} | null}
     */
    async getByEmail(email, include){
        const response = await this.prisma.findUnique({
            'where': {
                'email': email
            },
            'include': this.include(include), 
            'omit': {'additional_data': true}
        });
        if(response == null){
            throw new Model.Error("Record not found", 404);
        }
        if(!this._hasAccess(response)){
            throw new Model.Error("No permission", 403);
        }
        return response;
    }

    /**
     * @param {Object} data 
     * @returns  {Object}
     */
    async create(data){
        if(data.email != null && !this.validateEmail(data.email)){
            throw new Model.Error("Given email address is not valid", 400);
        }
        if(data.username != null && !this.validateUsername(data.username)){
            throw new Model.Error("Given username is not valid", 400);
        }
        if(!this.validatePassword(data.password)){
            throw new Model.Error("Given password doesn't fulfill requirements", 400);
        }
        data.hash = await bcrypt.hash(data.password, SALT_ROUNDS);
        data.status = "invited";
        const password = data.password;
        delete data.password;

        const response = await this._create(data);

        await this.sendValidationMail(response.id, "activation", {'password': password});

        return response;
    }

    /**
     * @param {number} id 
     * @param {{}} data 
     * @returns {Object}
     */
    async update(id, data){
        id = Number(id);
        // GET DATA FIRST
        const current_data = await this._get(id);

        if(data.email && !this.validateEmail(data.email)){
            throw new Model.Error("Given email address is not valid", 400);
        }

        if(data.status && data.status != current_data.status && !['super_admin', 'admin'].includes(this.user.role)){
            throw new Model.Error("You don't have permission to update the status", 403);
        }

        // DELETE HASH
        delete data.hash;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);

        let updated_user = await this.prisma.update({
            'where': {
                'id': id
            },
            'data': data,
            'include': this.include('ALL')
        });
        return updated_user;
    }

    /**
     * @param {number} id 
     * @returns {Object}
     */
    async delete(id){
        id = Number(id);
        const user = await this._get(id);
        if(user != null){
            return await this.prisma.delete({
                'where': {
                    'id': id
                }
            });
        }
        else{
            throw new Model.Error("User does not exist", 404);
        }
    }

    /**
     * @param {string | Object} include 
     * @returns {Object}
     */
    filter(include){
        // TODO: FILTER BY USER PERMISSION
        return {...this._filter(include), ...this.getAccessFilter()};
    }

    /**
     * @param {string | Object} include 
     * @returns {Object}
     */
    include(include){
        // TODO: INCLUDE BY USER PERMISSION
        return this._include(include);
    }

    // CUSTOM FUNCTIONS
    
    /**
     * @param {string} email 
     * @returns {Boolean}
     * 
     * @description Validates syntax of email address
     */
    validateEmail(email){
        return typeof email == 'string' && email.match(/^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/g) != null;
    }

    /**
     * @param {string} username 
     * @returns {Boolean}
     * 
     * @description Validates syntax of email address
     */
    validateUsername(username){
        return typeof username == 'string' && username.match(/^[a-zA-Z0-9_-]+$/g) != null;
    }

    /**
     * @param {string} password 
     * @returns {Boolean}
     * 
     * @description At least one uppercase letter, one lowercase letter, one number and one special characterm, at least 8 characters long and max. 32 characters
     */
    validatePassword(password){
        return typeof password == 'string' && password.match(/^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])(?=.*\W)(?!.* ).{8,32}$/) != null;
    }

    /**
     * 
     * @param {number} id 
     * @param {'activation' | 'password_reset'} reason
     * @param {any} data
     * @returns 
     */
    async sendValidationMail(id, reason = "activation", data = {}){
        const validation_email = {};
        if(reason == "password_reset"){
            validation_email.expires_at = (()=> {
                const expires_at = new Date();
                expires_at.setMinutes(expires_at.getMinutes() + 10);
                return expires_at;
            })();
        }
        if(reason == "activation"){
            validation_email.expires_at = (()=> {
                const expires_at = new Date();
                expires_at.setMonth(expires_at.getMonth() + 1);
                return expires_at;
            })();
        }

        const user = await this.prisma.findUnique({
            'where': {
                'id': id
            },
            'include': {
                'email_verification': true
            }
        });
        if(user.email_verification){
            await prisma.user_email_verification.delete({
                'where': {
                    'id': user.email_verification.id,
                    'reason': reason
                }
            });
        }
        let user_verification = await prisma.user_email_verification.create({
            'data': {
                'user': {
                    'connect': {
                        'id': id
                    }
                },
                'token': jwt.sign({'user_id': id, 'created_date': Date.now()}, process.env.SESSION_SECRET),
                'reason': reason,
                'expires_at': validation_email.expires_at,
                'createdBy': {
                    'connect': {
                        'id': this.user_id
                    }
                }
            },
            'include': {
                'user': true
            }
        });

        user_verification = {...user_verification, ...data};

        switch(reason){
            case "activation":
                validation_email.title = "Willkommen an Board";
                validation_email.template = "confirmation.ejs";
                validation_email.content = {
                    'viewInBrowser': `https://${process.env.DOMAIN}/mail/activation?activationToken=${user_verification.token}`,
                    'activation_uri': `https://${process.env.DOMAIN}/activateUser?activationToken=${user_verification.token}`
                };
                break;
            case "password_reset":
                validation_email.title = "Passwort zurcksetzen";
                validation_email.template = "resetPassword.ejs";
                validation_email.content = {
                    'viewInBrowser': `https://${process.env.DOMAIN}/mail/resetPassword?activationToken=${user_verification.token}`,
                    'password_reset_form_uri': `https://${process.env.FRONTEND_DOMAIN}/passwordReset/${user_verification.token}`
                };
                break;
            default:
                throw new Model.Error("Validation reason is not recoginized", 400);
        }

        // SEND ACTIVATION MAIL
        Object.assign(user_verification, validation_email.content)
        this.sendEmail(id, validation_email.title, validation_email.template, user_verification);

        return user_verification.token;
    }

    /**
     * @param {number} id 
     * @returns {boolean} 
     */
    async activate(id, invited = false){
        try{
            let user = await this._get(parseInt(id));
            if(!user || (invited && invited_user.status != "invited")){
                throw new Model.Error("No user found", 404);
            }
            user = await this._update(parseInt(id), {'status': "active"});
            const updateSevdeskContact = await RestApi.create('sevdesk', 'updateContact', {'params': {'id': user.additional_data.sevdesk_contact_id}});
            updateSevdeskContact.request({
                'status': 1000
            }).catch(error => {
                console.error(error);
            });
        }
        catch(error){
            console.error(error);
            return false;
        }
        
        return true;
    }

    /**
     * 
     * @param {string} token
     * @returns {boolean} 
     */
    async activateByToken(token){
        const user_verification = await prisma.user_email_verification.findUnique({
            'where': {
                'token': token
            }
        });
        if(user_verification){
            await prisma.user_email_verification.delete({
                'where': {
                    'token': token
                }
            });

            return await this.activate(user_verification.user_id, true);
        }
        return false;
    }

    async sendEmail(id, title, template, data, attachments = []){
        const user = await this.get(id);
        
        if(user?.email){
            try{
                const file = await Renderer.render(template, {'user': user, ...data}, {'language': "de-de", 'template': "email"});
                const _attachments = [
                    {
                        filename: 'icon50x50.png',
                        path: 'public/static/image/icon50x50.png',
                        cid: 'icon'
                    },
                    {
                        filename: 'logo200x52.png',
                        path: 'public/static/image/logo200x52.png',
                        cid: 'logo'
                    }
                ];
                new eMail('default', user.email, title, file, [..._attachments, ...attachments], (status)=>{
                    if(status)
                        console.log(`Email send to: ${user?.email}`);
                    else
                        console.error(`Failed to send Email to: ${user?.email}`);
                });
                return true;
            }
            catch(error){
                console.error(error);
                console.error(`Failed to send Email to: ${user?.email}`);

                return false;
            }
        }
        else{
            return false;
        }
    }

    /**
     * 
     * @param {string} email 
     */
    async sendPasswordEmailReset(email){
        const user = await this.getByEmail(email);
        if(user){
            await this.sendValidationMail(user.id, 'password_reset');
        }
        else{
            throw new Model.Error("User not found", 404);
        }
    }

    async changePassword(id, password){
        if(this.validatePassword(password)){
            const changePassword = await this._update(parseInt(id), {
                'hash': await bcrypt.hash(password, SALT_ROUNDS),
            },
            {
                'omit': {
                    'additional_data': true
                }
            });
            return changePassword ? true : false;
        }
        else{
            throw new Model.Error("New password doesn't fulfill requirements", 400);
        }
    }
}

module.exports = {User, QueryBuilder, prisma};