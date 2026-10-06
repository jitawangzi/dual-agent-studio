'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {atomicJson,workspaceKey,now}=require('./run-store');
const {normalizeReviewer}=require('./audit-config');
class AuditTemplates {
    constructor(root,catalog){this.file=path.join(root,'audit-templates.json');this.catalog=catalog;}
    all(){return fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):[];}
    list(workspace){const key=workspace?workspaceKey(workspace):null;return this.all().filter(t=>t.scope==='global'||t.workspaceKey===key);}
    save(input){
        const catalog=typeof this.catalog==='function'?this.catalog():this.catalog;
        if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('INVALID_TEMPLATE_NAME');
        if(!['global','project'].includes(input.scope))throw new Error('INVALID_TEMPLATE_SCOPE');
        const key=input.scope==='project'?workspaceKey(input.workspaceRoot):null;
        const c=input.config;
        if(!c||typeof c.commonPrompt!=='string'||!c.commonPrompt.trim()||typeof c.scope!=='string'||!Array.isArray(c.reviewers)||c.reviewers.length<1||c.reviewers.length>8)throw new Error('INVALID_TEMPLATE_CONFIG');
        if(!Number.isInteger(c.concurrency)||c.concurrency<1||c.concurrency>4||!Number.isInteger(c.timeoutSeconds)||c.timeoutSeconds<1||c.timeoutSeconds>7200)throw new Error('INVALID_TEMPLATE_LIMIT');
        const records=this.all(),old=input.id?records.find(t=>t.id===input.id):null;
        if(input.id&&!old)throw new Error('TEMPLATE_NOT_FOUND');
        if(old&&(input.version!==old.version||old.workspaceKey!==key||old.scope!==input.scope))throw new Error('TEMPLATE_VERSION_CONFLICT');
        const template={id:old?.id||crypto.randomUUID(),name:input.name.trim(),scope:input.scope,workspaceKey:key,
            version:(old?.version||0)+1,createdAt:old?.createdAt||now(),updatedAt:now(),
            config:{commonPrompt:c.commonPrompt.trim(),scope:c.scope.trim(),concurrency:c.concurrency,timeoutSeconds:c.timeoutSeconds,
                reviewers:c.reviewers.map((r,i)=>normalizeReviewer(r,i,catalog))}};
        atomicJson(this.file,old?records.map(t=>t.id===old.id?template:t):[...records,template]);return template;
    }
    remove(input){
        const records=this.all(),old=records.find(t=>t.id===input.id);
        if(!old)throw new Error('TEMPLATE_NOT_FOUND');
        if(old.version!==input.version)throw new Error('TEMPLATE_VERSION_CONFLICT');
        if(old.workspaceKey&&old.workspaceKey!==workspaceKey(input.workspaceRoot))throw new Error('TEMPLATE_WORKSPACE_MISMATCH');
        atomicJson(this.file,records.filter(t=>t.id!==old.id));return {deleted:true};
    }
}
module.exports={AuditTemplates};
