const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {ejsRender} = require('../../lib/ejsRender');
const eMail = require('../../lib/SendMail');
const {RestApi} = require('../../lib/RestApi')
const {Model, QueryBuilder, prisma} = require('../Model');
const {Contact} = require('../EspoCRM/EspoCRM');
const pushLog = require('../../lib/pushLog');

const Renderer = new ejsRender();

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || 10);

const SEVDESK_DATA = {
    'contact_student_id': 879034,
    'contact_teacher_id': 879035,
    'bg_number': 8620,
    'contactAddressCategory': 44,
    'billingAddressCategory': 47
}

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
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder, {'omit': {'additional_data': true}});
    }

    /**
     * @param {number} id 
     * @param {string | Object} include 
     * @returns {{} | null}
     */
    async get(id, include){
        return await this._get(Number(id), include, {'omit': {'additional_data': true}});
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

        delete data.additional_data;

        // USER ROLE VALIDATION
        switch(data.role){
            case "admin":
            case "super_admin":
                if(data.student != undefined || data.teacher != undefined){
                    throw new Model.Error(`role is set to ${data.role} but '${data.student ? 'student' : 'teacher'}' object is given`, 400);
                }
                break;
            case "student":
                if(typeof data.student != 'object'){
                    throw new Model.Error(`role is set to ${data.role} but related object is missing`, 400);
                }
                if(typeof data.teacher == 'object'){
                    throw new Model.Error(`role is set to ${data.role} but teacher object is given`, 400);
                }
                break;
            case "teacher":
                if(typeof data.teacher != 'object'){
                    throw new Model.Error(`role is set to ${data.role} but related object is missing`, 400);
                }
                if(typeof data.student == 'object'){
                    throw new Model.Error(`role is set to ${data.role} but student object is given`, 400);
                }
                break;
            default:
                throw new Model.Error("Role is invalid", 400);
        }

        const response = await this._create(data, {'omit': {'additional_data': true}});
        
        if(response.role != 'super_admin' && response.role != 'admin'){
            
            const sevdesk_response = await this.#createSevdeskContact(response);

            const updateSevdeskData = {
                'additional_data': {
                    'sevdesk_contact_id': parseInt(sevdesk_response.id)
                }
            }

            if(sevdesk_response.email){
                updateSevdeskData.additional_data.sevdesk_email_id = sevdesk_response.email.id;
            }

            if(sevdesk_response.phone){
                updateSevdeskData.additional_data.sevdesk_phone_id = sevdesk_response.phone.id;
            }

            if(sevdesk_response.bg_number){
                updateSevdeskData.additional_data.sevdesk_bg_number_id = sevdesk_response.bg_number.id;
            }

            if(sevdesk_response.contactAddress){
                await prisma.address.update({
                    'where': {
                        'id': response.contactAddress.id
                    },
                    'data': {
                        'sevdesk_address_id': parseInt(sevdesk_response.contactAddress.id)
                    }
                });
            }

            if(sevdesk_response.billingAddress){
                await prisma.address.update({
                    'where': {
                        'id': response.billingAddress.id
                    },
                    'data': {
                        'sevdesk_address_id': parseInt(sevdesk_response.billingAddress.id)
                    }
                });
            }

            if(response.role == "student"){
                updateSevdeskData.student = {
                    'customer_number': sevdesk_response.customerNumber,
                    'school_level': response.student.school_level
                }
            }
            this.constructor.queryBuilder.update(response.id, updateSevdeskData, this.user_id);

            await this.prisma.update({
                'data': updateSevdeskData,
                'where': {
                    'id': parseInt(response.id)
                }
            });
        }

        await this.sendValidationMail(response.id, "activation", {'password': password});
        Contact.upsertUserContact(response).then(()=>{
            console.log("EspoCRM Contact Upsert Success");
        }).catch((error) =>{
            pushLog(error, "EspoCRM Upsert Failed");
        });
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

        // USER ROLE VALIDATION
        if(data.role && data.role != current_data.role){
            throw new Model.Error("Role of user cannot be changed", 409);
        }
        else{
            data.role = current_data.role;
        }

        switch(data.role){
            case "admin":
            case "super_admin":
                if(data.student != undefined || data.teacher != undefined){
                    throw new Model.Error(`role is set to ${data.role} but '${data.student ? 'student' : 'teacher'}' object is given`, 400);
                }
                break;
            case "student":
                if(typeof data.teacher == 'object'){
                    throw new Model.Error(`role is set to ${data.role} but teacher object is given`, 400);
                }
                break;
            case "teacher":
                if(typeof data.student == 'object'){
                    throw new Model.Error(`role is set to ${data.role} but student object is given`, 400);
                }
                break;
        }

        if(data.email && !this.validateEmail(data.email)){
            throw new Model.Error("Given email address is not valid", 400);
        }

        if(data.status && data.status != current_data.status && !['super_admin', 'admin'].includes(this.user.role)){
            throw new Model.Error("You don't have permission to update the status", 403);
        }

        // DELETE HASH & ADDITIONAL_DATA PROPERTY
        delete data.hash;
        delete data.additional_data;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);

        let updated_user = await this.prisma.update({
            'where': {
                'id': id
            },
            'data': data,
            'include': this.include('ALL')
        });

        if(updated_user.role == "student" || updated_user.role == "teacher"){
            let sevdesk_response;
            const sevdesk_contact_data = updated_user.additional_data;
            if(updated_user.additional_data.sevdesk_contact_id){
                try{
                    sevdesk_response = await this.#updateSevdeskContact(updated_user);
                }
                catch(error){
                    console.error(error);
                    
                    sevdesk_response = await this.#createSevdeskContact(updated_user);
                    sevdesk_contact_data.sevdesk_contact_id = parseInt(sevdesk_response.id)
                }
            }
            else{
                sevdesk_response = await this.#createSevdeskContact(updated_user);
                sevdesk_contact_data.sevdesk_contact_id = parseInt(sevdesk_response.id)
            }

            if(sevdesk_response.bg_number?.id){
                sevdesk_contact_data.sevdesk_bg_number_id = sevdesk_response.bg_number.id;
            }

            // COMMS
            if(updated_user.additional_data.sevdesk_email_id != sevdesk_response.email?.id){
                sevdesk_contact_data.sevdesk_email_id = sevdesk_response.email ? parseInt(sevdesk_response.email.id) : null;
            };
            if(updated_user.additional_data.sevdesk_phone_id != sevdesk_response.phone?.id){
                sevdesk_contact_data.sevdesk_phone_id = sevdesk_response.phone ? parseInt(sevdesk_response.phone.id) : null;
            }
            if(Object.keys(sevdesk_contact_data).length > 0){
                updated_user = await this.prisma.update({
                    'where': {
                        'id': id
                    },
                    'data': {
                        'additional_data': sevdesk_contact_data
                    },
                    'include': this.include('ALL')
                });
            }

            // contactAddress created on User Update
            if(updated_user.contactAddress?.sevdesk_address_id != sevdesk_response.contactAddress?.id){
                await prisma.address.update({
                    'where': {
                        'id': updated_user.contactAddress.id
                    },
                    'data': {
                        'sevdesk_address_id': parseInt(sevdesk_response.contactAddress.id)
                    }
                });
            }
            // billingAddress created on User Update
            if(updated_user.billingAddress?.sevdesk_address_id != sevdesk_response.billingAddress?.id){
                await prisma.address.update({
                    'where': {
                        'id': updated_user.billingAddress.id
                    },
                    'data': {
                        'sevdesk_address_id': parseInt(sevdesk_response.billingAddress.id)
                    }
                });
            }
        }
        delete updated_user.additional_data;
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
            if(user.contact_address_id){
                await prisma.address.delete({
                    'where': {
                        'id': user.contact_address_id
                    }
                });
            }
            
            if(user.billing_address_id){
                await prisma.address.delete({
                    'where': {
                        'id': user.billing_address_id
                    }
                });
            }
            if(user.role != "super_admin" && user.role != "admin"){
                const deleteSevdeskContact = await RestApi.create('sevdesk', 'deleteContact', {'params': {'id': user.additional_data.sevdesk_contact_id}});
                deleteSevdeskContact.request().then((response) => {
                    console.log(response);
                }).catch((error) => {
                    pushLog(error, "FAILED DLETING SEVDESK CONTACT");
                });
            }
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

    async #createSevdeskContact(data){
        // CREATE SEVDESK CONTACT
        const sevdeskContact = await RestApi.create('sevdesk', 'createContact');
        try{
            const sevdesk_response = (await sevdeskContact.request({
                'status': 100,
                'surename': data.billingAddress?.first_name || data.first_name,
                'familyname': data.billingAddress?.last_name || data.last_name,
                "category": {
                    "id": data.role == 'student' ? SEVDESK_DATA.contact_student_id : SEVDESK_DATA.contact_teacher_id,
                    "objectName": "Category"
                },
                "academicTitle": data.billingAddress?.title || data.academic_title,
                "gender": data.gender == "Male" ? "Herr" : data.gender == "Female" ? "Frau": null,
                "birthday": data.date_of_birth,
                "bankAccount": data.role == 'teacher' ? data.teacher.iban : null,
                "bankNumber": data.role == 'teacher' ? data.teacher.bic : null,
                "taxNumber": data.role == 'teacher' ? data.teacher.tax_number : null,
                "governmentAgency": false
            })).objects;

            const sevdesk_relations = ['contactAddress', 'billingAddress', 'email', 'phone', 'bg_number'];
            const sevdesk_requests = [];

            if(data.contactAddress){
                sevdesk_requests[0] = this.#createSevdeskAddress(sevdesk_response.id, data.contactAddress, {'category': SEVDESK_DATA.contactAddressCategory});
            }
            if(data.billingAddress){
                sevdesk_requests[1] = this.#createSevdeskAddress(sevdesk_response.id, data.billingAddress, {'category': SEVDESK_DATA.billingAddressCategory});
            }
            if(data.email){
                sevdesk_requests[2] = this.#createSevdeskCommunication(sevdesk_response.id, 'EMAIL', data.email);
            }
            if(data.phone){
                sevdesk_requests[3] = this.#createSevdeskCommunication(sevdesk_response.id, 'PHONE', data.phone);
            }

            if(data.role == "student" && data.student?.bg_number){
                sevdesk_requests[4] = this.#createSevdeskBGNumber(sevdesk_response.id, data.student.bg_number, data.date_of_birth);
            }

            const sevdesk_relation_responses = await Promise.allSettled(sevdesk_requests);
            for(let i = 0; i < sevdesk_relation_responses.length; i++){
                sevdesk_response[sevdesk_relations[i]] = sevdesk_relation_responses[i].status == "fulfilled" ? sevdesk_relation_responses[i].value : null;
            }
            
            return sevdesk_response;
        }
        catch(error){
            console.error(error);
            throw new Model.Error("Couldn't create sevdesk contact.", 500);
        }
    }

    async #updateSevdeskContact(data){
        try{
            const payload = {
                'status': data.status == 'active' ? 1000 : 100,
                'surename': data.first_name,
                'familyname': data.last_name,
                "academicTitle": data.academic_title,
                "gender": data.gender == "Male" ? "Herr" : data.gender == "Female" ? "Frau": null,
                "birthday": data.date_of_birth,
                "bankAccount": data?.role == 'teacher' ? data?.teacher?.iban : null,
                "bankNumber": data?.role == 'teacher' ? data?.teacher?.bic : null,
                "taxNumber": data?.role == 'teacher' ? data?.teacher?.tax_number : null,
                "governmentAgency": false
            };
            const updateSevdeskContact = await RestApi.create('sevdesk', 'updateContact', {'params': {'id': data.additional_data.sevdesk_contact_id}});
            const sevdesk_response = (await updateSevdeskContact.request(payload)).objects;

            const sevdesk_relations = ['contactAddress', 'billingAddress', 'email', 'phone', 'bg_number'];
            const sevdesk_requests = [];

            if(data.contactAddress?.sevdesk_address_id){
                sevdesk_requests[0] = this.#updateSevdeskAddress(data.contactAddress, data.contactAddress.sevdesk_address_id);
            }
            else{
                sevdesk_requests[0] = this.#createSevdeskAddress(sevdesk_response.id, data.contactAddress, {'category': SEVDESK_DATA.contactAddressCategory});
            }
            if(data.billingAddress?.sevdesk_address_id){
                sevdesk_requests[1] = this.#updateSevdeskAddress(data.billingAddress, data.billingAddress.sevdesk_address_id);
            }
            else{
                sevdesk_requests[1] = this.#createSevdeskAddress(sevdesk_response.id, data.billingAddress, {'category': SEVDESK_DATA.billingAddressCategory});
            }
            sevdesk_requests[2] = this.#updateSevdeskCommunication(data.additional_data.sevdesk_email_id, sevdesk_response.id, 'EMAIL', data.email);
            sevdesk_requests[3] = this.#updateSevdeskCommunication(data.additional_data.sevdesk_phone_id, sevdesk_response.id, 'PHONE', data.phone);
            sevdesk_requests[4] = this.#updateSevdeskBGNumber(sevdesk_response.id, data.additional_data.sevdesk_bg_number_id, data.student?.bg_number, data.date_of_birth);

            const sevdesk_relation_responses = await Promise.allSettled(sevdesk_requests);
            for(let i = 0; i < sevdesk_relation_responses.length; i++){
                sevdesk_response[sevdesk_relations[i]] = sevdesk_relation_responses[i].status == "fulfilled" ? sevdesk_relation_responses[i].value : null;
            }
            return sevdesk_response;
        }
        catch(error){
            console.error(error);
            throw new Model.Error("Couldn't update sevdesk contact.", 500);
        }
    }

    async #createSevdeskAddress(sevdesk_contact_id, data, options = {'category': SEVDESK_DATA.billingAddressCategory}){
        try{
            const payload = {
                'contact': {
                    'id': sevdesk_contact_id,
                    'objectName': "Contact"
                },
                'street': data.address_line,
                'zip': data.postal_code,
                'city': data.city,
                'country': {
                    'id': 1, // GERMANY
                    'objectName': "StaticCountry"
                },
                'category': {
                    'id': options.category,
                    'objectName': "Category"
                },
                'name': `${data.first_name} ${data.last_name}`
            };
            const createSevdeskAddress = await RestApi.create('sevdesk', 'createContactAddress');
            const sevdesk_response = (await createSevdeskAddress.request(payload)).objects;
    
            return sevdesk_response;
        }
        catch(error){
            console.error(error);
            throw new Model.Error("Couldn't create sevdesk contact address.", 500);
        }
    }

    async #updateSevdeskAddress(data, sevdesk_address_id = null){
        try{
            const payload = {
                'street': data.address_line,
                'zip': data.postal_code,
                'city': data.city,
                'country': {
                    'id': 1, // GERMANY
                    'objectName': "StaticCountry"
                },
                'name': `${data.first_name} ${data.last_name}`
            };
            const updateSevdeskAddress = await RestApi.create('sevdesk', 'updateContactAddress', {'params': {'id': sevdesk_address_id}});
            const sevdesk_response = (await updateSevdeskAddress.request(payload)).objects;
    
            return sevdesk_response;
        }
        catch(error){
            console.error(error);
            if(sevdesk_contact_id && error.status_code == 404){
                return await this.#createSevdeskAddress(sevdesk_contact_id, data, {'category': SEVDESK_DATA.billingAddressCategory});
            }
            throw new Model.Error("Couldn't update sevdesk contact address.", 500);
        }
    }

    /**
     * 
     * @param {number} sevdesk_contact_id
     * @param {'EMAIL'|'PHONE'} type 
     * @param {string} value 
     * @returns {Promise<Object>}
     */
    async #createSevdeskCommunication(sevdesk_contact_id, type, value){
        try{
            const payload = {
                'contact': {
                    'id': sevdesk_contact_id,
                    'objectName': "Contact"
                },
                "type": type,
                "value": value,
                "key": {
                    "id": 8,
                    "objectName": "CommunicationWayKey"
                },
                "main": false
            };
            const createSevdeskComm = await RestApi.create('sevdesk', 'createContactCommunication');
            return (await createSevdeskComm.request(payload)).objects;
        }
        catch(error){
            console.error("Couldn't create sevdesk communication", error);
            throw new Model.Error(`Couldn't create sevdesk ${type} communication`, 500);
        }
    }

    /**
     * 
     * @param {number} sevdesk_communication_id
     * @param {'EMAIL'|'PHONE'} type 
     * @param {string} value 
     * @param {number|null} sevdesk_contact_id 
     * @returns {Promise<Object>}
     */
    async #updateSevdeskCommunication(sevdesk_communication_id, sevdesk_contact_id, type, value){
        try{
            if(sevdesk_communication_id){
                if(value){
                    const payload = {
                        'contact': {
                            'id': sevdesk_contact_id,
                            'objectName': "Contact"
                        },
                        "type": type,
                        "value": value,
                        "key": {
                            "id": 8,
                            "objectName": "CommunicationWayKey"
                        },
                        "main": false
                    };
                    const updateSevdeskComm = await RestApi.create('sevdesk', 'updateContactCommunication', {'params': {'id': sevdesk_communication_id}});
                    const sevdesk_response = (await updateSevdeskComm.request(payload)).objects;
                    return sevdesk_response;
                }
                else{
                    await this.#deleteSevdeskCommunication(sevdesk_communication_id);
                }
            }
            else {
                if(value){
                    return await this.#createSevdeskCommunication(sevdesk_contact_id, type, value);
                }
            }
        }
        catch(error){
            console.error("Couldn't update sevdesk communication", error);
            if(sevdesk_communication_id && error.status_code == 404){
                return await this.#createSevdeskCommunication(sevdesk_contact_id, type, value);
            }
            throw new Model.Error(`Couldn't update sevdesk ${type} communication`, 500);
        }
        return null;
    }

    /**
     * 
     * @param {number} sevdesk_contact_id
     * @param {'EMAIL'|'PHONE'} type 
     * @param {string} value 
     * @returns {Promise<Object>}
     */
    async #deleteSevdeskCommunication(sevdesk_communication_id){
        try{
            const deleteSevdeskComm = await RestApi.create('sevdesk', 'deleteContactCommunication', {'params': {'id': sevdesk_communication_id}});
            await deleteSevdeskComm.request();
            return true;
        }
        catch(error){
            console.error("Couldn't delete sevdesk communication", error);
            throw new Model.Error(`Couldn't delete sevdesk ${type} communication`, 500);
        }
    }

    async #createSevdeskBGNumber(sevdesk_contact_id, bg_number, birthday = null){
        let value = bg_number;
        if(birthday){
            const date_of_birth = (new Date(birthday)).toLocaleDateString('de-DE', {
                'day': "2-digit",
                'month': "2-digit",
                'year': "numeric",
            });
            value += ` - ${date_of_birth}`;
        }
        try{
            const sevdeskContactBgNumber = await RestApi.create('sevdesk', 'createContactCustomField');
            const payload = {
                "contact": {
                    'id': parseInt(sevdesk_contact_id),
                    'objectName': "Contact"
                },
                "contactCustomFieldSetting": {
                    'id': SEVDESK_DATA.bg_number,
                    'objectName': "ContactCustomFieldSetting"
                },
                'value': value,
                'objectName': "ContactCustomField"
            };
            return (await sevdeskContactBgNumber.request(payload)).objects;
        }
        catch(error){
            console.error(error);
            throw new Model.Error("Couldn't add BG-Number to Sevdesk Contact", 500);
        }
    }
    async #updateSevdeskBGNumber(sevdesk_contact_id, sevdesk_bg_number_id, bg_number, birthday = null){
        let value = bg_number;
        if(birthday){
            const date_of_birth = (new Date(birthday)).toLocaleDateString('de-DE', {
                'day': "2-digit",
                'month': "2-digit",
                'year': "numeric",
            });
            value += ` - ${date_of_birth}`;
        }
        try{
            if(sevdesk_bg_number_id && !isNaN(sevdesk_bg_number_id)){
                const sevdeskContactBgNumber = await RestApi.create('sevdesk', 'updateContactCustomField', {'params': {'id': sevdesk_bg_number_id}});
                const payload = {
                    "contact": {
                        'id': parseInt(sevdesk_contact_id),
                        'objectName': "Contact"
                    },
                    "contactCustomFieldSetting": {
                        'id': SEVDESK_DATA.bg_number,
                        'objectName': "ContactCustomFieldSetting"
                    },
                    'value': value,
                    'objectName': "ContactCustomField"
                };
                return (await sevdeskContactBgNumber.request(payload)).objects;
            }
            return await this.#createSevdeskBGNumber(sevdesk_contact_id, bg_number, birthday);
        }
        catch(error){
            console.error(error);
            if(sevdesk_bg_number_id && error.status_code == 404){
                return await this.#createSevdeskBGNumber(sevdesk_contact_id, bg_number, birthday);
            }
            throw new Model.Error("Couldn't update Sevdesk Contacts BG Number", 500);
        }
    }
}

User.relatedObjects = [
    {'name': "teacher", 'object': "teacher", 'access': {'student': false}, 'relation': [
        {'name': "courses", 'object': "course_teacher", 'field': "course_id_teacher_id", 'fields': ["teacher_id", "course_id"], 'access': {'admin': ['course_id'], 'student': false}, 'relation': [
            {'name': "course", 'object': "course", 'field': "course_id", 'access': {}}
        ]},
    ]},
    {'name': "student", 'object': "student", 'access': {'teacher': false}, 'relation': [
        {'name': "agency", 'object': "agency", 'access': {'student': false, 'teacher': false}, 'relation': [
            {'name': "contactAddress", 'object': "address", 'field': "contact_address_id", 'access': {'teacher': false}},
            {'name': "billingAddress", 'object': "address", 'field': "billing_address_id", 'access': {'teacher': false}}
        ]},
        {'name': "school", 'object': "school", 'field': "school_id", 'relation': [
            {'name': "contactAddress", 'object': "address", 'field': "contact_address_id"},
            {'name': "billingAddress", 'object': "address", 'field': "billing_address_id", 'access': {'student': false, 'teacher': false}}
        ]},
        {'name': "courses", 'object': "course_student", 'field': "course_id_student_id", 'fields': ["student_id", "course_id"], 'access': {'student': [], 'teacher': false}, 'relation': [
            {'name': "course", 'object': "course", 'field': "course_id", 'access': {'student': ['id', 'name', 'url', 'location']}}
        ]}
    ]},
    {'name': "contactAddress", 'object': "address", 'field': "contact_address_id"},
    {'name': "billingAddress", 'object': "address", 'field': "billing_address_id"}
];

User.hasAccess = (data, user) => {
    switch(user.role){
        case "student":
        case "teacher":
            return user.id == data.id;
        case "admin":
            return data.rule != "super_admin";
        case "super_admin":
            return true;
    }
}

User.getAccessFilter = (user) => {
    switch(user.role){
        case "student":
        case "teacher":
            return {
                'id': user.id
            }
        case "admin":
            return {
                'role': {
                    'not': "super_admin"
                }
            }
        case "super_admin":
            return true;
    }
}

User.inaccessible_fields = {
    'role':{
        'student': ['additional_data'],
        'teacher': ['additional_data']
    }
}

User.queryBuilder = new QueryBuilder("user", User);

module.exports = {User, QueryBuilder, prisma};