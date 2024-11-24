const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {ejsRender} = require('../../lib/ejsRender');
const eMail = require('../../lib/SendMail');
const RestApi = require('../../lib/RestApi')
const {Model, QueryBuilder, prisma} = require('../Model');

const Renderer = new ejsRender();

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || 10);

class User extends Model {
    constructor(options){
        super('user', options);
    }

    /**
     * @param {string} q 
     * @param {string} include 
     * @param {number} limit 
     * @param {number} offset 
     * @param {string} sortBy 
     * @param {string} sortOrder 
     * @returns {Object[]}
     */
    async getAll(q = {}, include = {}, limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getAll(q, include, limit, offset, sortBy, sortOrder);
    }

    /**
     * @param {number} id 
     * @param {string | Object} include 
     * @returns {{} | null}
     */
    async get(id, include){
        return await this._get(id, include);
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
            'include': this.include(include)
        });
        if(response == null){
            throw new ErrorResponse("Record not found", 404);
        }
        if(!this._hasAccess(response)){
            throw new ErrorResponse("No permission", 403);
        }
        return response;
    }

    /**
     * @param {Object} data 
     * @returns  {Object}
     */
    async create(data){
        if(!this.validateEmail(data.email)){
            throw new Model.Error("Given email address is not valid", 400);
        }
        if(!this.validatePassword(data.password)){
            throw new Model.Error("Given password doesn't fulfill requirements", 400);
        }
        data.hash = await bcrypt.hash(data.password, SALT_ROUNDS);
        delete data.password;

        const response = await this._create(data);
        

        await this.sendValidationMail(response.id);

        return response;
    }

    /**
     * @param {number} id 
     * @param {{}} data 
     * @returns {Object}
     */
    async update(id, data){
        // GET DATA FIRST
        const current_data = await this._get(id);

        // DELETE HASH PROPERTY
        delete data.hash;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);

        let updated_user = await this.prisma.update({
            'data': data,
            'where': {
                'id': parseInt(id)
            },
            'include': this.include('ALL')
        });

        return updated_user;
    }

    /**
     * @param {number} id 
     * @returns {Object}
     */
    async delete(id){
        const user = await this.get(id);
        if(user != null){
            if(user.contact_address_id){
                await prisma.address.delete({
                    where: {
                        'id': user.contact_address_id
                    }
                });
            }
            
            if(user.billing_address_id){
                await prisma.address.delete({
                    where: {
                        'id': user.billing_address_id
                    }
                });
            }
    
            return await prisma.user.delete({
                where: {
                    id: parseInt(id)
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
        return {...this._filter(include), ...this._getAccessFilter()};
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
     * @returns 
     */
    async sendValidationMail(id, reason = "activation"){
        const validation_email = {};
        if(reason == "password_reset"){
            validation_email.expires_at = (()=> {
                const expires_at = new Date();
                expires_at.setMinutes(expires_at.getMinutes() + 10)
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
        const user_verification = await prisma.user_email_verification.create({
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
                    'viewInBrowser': `https://${process.env.DOMAIN}/mail/passwordReset?activationToken=${user_verification.token}`,
                    'password_reset_form_uri': `https://${process.env.FRONTEND_DOMAIN}/resetPassword?activationToken=${user_verification.token}`
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
    async activate(id){
        const user = await this._update(id, {'status': "active"});
        
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

            return await this.activate(user_verification.user_id);
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
            const changePassword = await this._update(id, {
                'hash': await bcrypt.hash(password, SALT_ROUNDS),
            });
            return changePassword ? true : false;
        }
        return false;
    }
}

/**
 * [{'name': "prisma.relation.name", 'object': "prisma.object.name", 'access': {'role.name': true|false|['field_name']}, 'relation': [
        {'name': "prisma.relation.name", 'object': "prisma.object.name", 'field': "foreign_key", 'relation': [
            {'name': "prisma.relation.name", 'object': "prisma.object.name", 'field': "foreign_key"},
            {'name': "prisma.relation.name", 'object': "prisma.object.name", 'field': "foreign_key", 'access': {'role.name': false, 'role.name': false}}
        ]}
    ]},]
 */
User.relatedObjects = [

];

/**
 * {
 *  'user_field': {
 *      'user_field_value': {
 *          'object.relation.[...]': {
 *              'field': ['user.relation', 'user.relation.relation.[...]', 'user.relation.relation.[...].field]
 *          }
 *      }
 *  }
 * }
 */
User.access_rule = {
    'role':{
        'enum_value_1':{
            'id': ['id']
        },
        'enum_value_2':{
            'id': ['id']
        }
    }
}

/**
 * {
 *  'user_field': {
 *      'user_field_value': ['object.fields']
 *  }
 */
User.inaccessible_fields = {
    'role':{
        'student': [],
        'teacher': []
    }
}

User.queryBuilder = new QueryBuilder("user", User);

module.exports = {User, QueryBuilder, prisma};