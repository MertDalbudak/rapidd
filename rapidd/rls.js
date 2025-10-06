const rls = {
    model: {},
    lastUpdateDate: null
};

rls.model.user = {
    canCreate: (user) => {
        return user?.role == 'admin' || user?.role == 'super_admin';
    },
    hasAccess: (data, user) => {
        return data.id == user.id;
    },
    getAccessFilter: (user) =>{
        switch(user?.role){
            case "admin":
                return {
                    'role': {
                        'not': "super_admin"
                    }
                };
            case "super_admin":
                return {}; // true was used before, but we need an empty object for Prisma
            default:
                if(user){
                    return {id: user.id};
                }
                return {id: -1};
        }
    },
    getUpdateFilter: (user) =>{
        switch(user?.role){
            case "admin":
                return {
                    'role': {
                        'not': "super_admin"
                    }
                };
            case "super_admin":
                return {};
            default:
                if(user){
                    return {id: user.id};
                }
                return {id: -1};
        }
    },
    getDeleteFilter: (user) => {
        switch(user?.role){
            case "admin":
                return {
                    'role': {
                        'not': "super_admin"
                    }
                };
            case "super_admin":
                return {};
            default:
                if(user){
                    return {id: user.id};
                }
                return {id: -1};
        }
    },
    getOmitFields: (user) => {
        switch(user?.role){
            case "admin":
                return [];
            case "super_admin":
                return [];
            default:
                return []
        }
    }
}

module.exports = rls;