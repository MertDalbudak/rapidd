import type { AclConfig, RapiddUser } from '../types';

const acl: AclConfig = {
    model: {
        company_members: {
            canCreate: (user: RapiddUser): boolean => {
                return user?.canManageMembers === true || user?.userId === user?.id || user?.role === 'ADMIN' || user?.userId === user?.id || user?.role === 'COMPANY' || user?.role === 'ADMIN';
            },
            getAccessFilter(user: RapiddUser): Record<string, unknown> | boolean {
                return true; if (user?.role === 'COMPANY' || user?.role === 'ADMIN') return {};
                return { userId: user?.id };
            },
            getUpdateFilter: (user: RapiddUser): Record<string, unknown> | boolean | false => {
                if (['COMPANY', 'ADMIN'].includes(user?.role)) { return {}; } return false;
            },
            getDeleteFilter: (user: RapiddUser): Record<string, unknown> | boolean | false => {
                if (['COMPANY', 'ADMIN'].includes(user?.role)) { return {}; } return false;
            },
            getOmitFields: (user: RapiddUser): string[] => []
        },
        addresses: {
            canCreate(user: RapiddUser): boolean {
                return (
                    (this as any)?.data?.userId === user.id ||
                    user.role === 'COMPANY' ||
                    user.role === 'ADMIN'
                );
            },

            getAccessFilter(user: RapiddUser): Record<string, unknown> | boolean {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getUpdateFilter(user: RapiddUser): Record<string, unknown> | boolean | false {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getDeleteFilter(user: RapiddUser): Record<string, unknown> | boolean | false {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getOmitFields(_user: RapiddUser): string[] {
                return [];
            },
        },

        application_documents: {
            canCreate(user: RapiddUser): boolean {
                return (
                    (this as any)?.data?.userId === user.id ||
                    user.role === 'ADMIN'
                );
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        application_status_history: {
            canCreate(user: RapiddUser): boolean {
                return ['COMPANY', 'ADMIN'].includes(user.role);
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        applications: {
            canCreate(user: RapiddUser): boolean {
                return (
                    (this as any)?.data?.userId === user.id ||
                    user.role === 'ADMIN'
                );
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'COMPANY' || user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        audit_logs: {
            canCreate(): boolean {
                return true;
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { userId: user.id };
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        categories: {
            canCreate(user: RapiddUser): boolean {
                return user.role === 'ADMIN';
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        messages: {
            canCreate(user: RapiddUser): boolean {
                return (
                    (this as any)?.data?.senderId === user.id ||
                    user.role === 'ADMIN'
                );
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};

                return {
                    AND: [
                        { senderId: user.id },
                        { recipientId: user.id },
                    ],
                };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};

                return {
                    AND: [
                        { senderId: user.id },
                        { recipientId: user.id },
                    ],
                };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};

                return {
                    AND: [
                        { senderId: user.id },
                        { recipientId: user.id },
                    ],
                };
            },

            getOmitFields(): string[] {
                return [];
            },
        },

        users: {
            canCreate(): boolean {
                return true;
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { id: user.id };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { id: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getOmitFields(): string[] {
                return [];
            },
        },
    },
};

export default acl;
