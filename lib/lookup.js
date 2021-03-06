'use strict'
const fs = require('fs');
const find = require('findit');
const path = require('path');
const uuid = require('uuid');
const sqlite3 = require('sqlite3-lite');
const {open} = require('sqlite');

function Lookup(config) {
    this.config = config;
    this.initialized = false;
}

Lookup.prototype.createDbConnection = function(filename) {
    if (!fs.existsSync(filename) && filename != ':memory:') {
        fs.close(fs.openSync(filename, 'w'));
    }
    return open({
        filename,
        driver: sqlite3.cached.Database
    });
};

Lookup.prototype.init = async function() {
    this.db = await this.createDbConnection(this.config.aclDatabaseFile);
    let initSql = fs.readFileSync(`${__dirname}/sql/create.sql`).toString().split('\n');
    try {
        for(let i=0; i < initSql.length; i++) {
            if (initSql[i] !== '') {
                await this.db.run(initSql[i]);
            }
        }
    } catch (err) {
        console.error(`Failed to initialize database: ${err.message}`);
    }
    this.initialized = true;
};

/*
 * WARNING: This clears out the entire lookup db.
 */
Lookup.prototype.cleanup = async function() {
    if (!this.initialized) {
        throw Error('Database has not been initialized');
    }
    let deleteSql = fs.readFileSync(`${__dirname}/sql/delete.sql`).toString().split('\n');
    try {
        for(let i = 0; i < deleteSql.length; i++) {
            await this.db.run(deleteSql[i]);
        }
    } catch (err) {
        console.error(`Failed to initialize database: ${err.message}`);
    }
    this.initialized = false;
};

Lookup.prototype.close = async function() {
    try {
        if (this.db) {
            await this.db.close();
        }
    } catch(err) {
        console.error(`Failed to close sqlite db: ${err.message}`);
    }
};

Lookup.prototype.addHostName = async function(hostname, category) {
    if (!this.initialized) {
        throw Error('Database has not been initialized');
    }
    if (!hostname || hostname.split('.').indexOf('') > -1 || hostname.length > 128) {
        throw Error(`Invalid hostname: ${hostname}`);
    }
    const categorySql = 'INSERT INTO categories(categoryText)' +
        ' SELECT ? WHERE NOT EXISTS(SELECT 1 FROM categories WHERE categoryText = ?);';
    const domainSql = 'INSERT INTO domains(domainText, categoryId) ' +
        ' SELECT ?, id FROM categories WHERE categoryText = ?' +
        ' AND NOT EXISTS(SELECT 1 FROM domains WHERE domainText = ? AND categoryId = id);'
    try {
        await this.db.run(categorySql, category, category);
        await this.db.run(domainSql, hostname, category, hostname);
    } catch (err) {
        console.error(err.message);
    }
};

Lookup.prototype.lookupHostName = async function(hostname, category) {
    if (!this.initialized) {
        throw Error('Database has not been initialized');
    }
    let parts = hostname.split('.');
    const getSql = (category === 'any') ? 'SELECT domains.domainText, categories.categoryText FROM domains ' +
        'INNER JOIN categories ON domains.categoryId = categories.id ' +
        'WHERE domainText = ?;'
        : 'SELECT domains.domainText, categories.categoryText FROM domains ' +
        'INNER JOIN categories ON domains.categoryId = categories.id ' +
        'WHERE domainText = ? AND categoryText = ?;';
    while(parts.length > 1) {
        let domain = parts.join('.');
        try {
            const result = (category === 'any')
                ? await this.db.get(getSql, domain)
                : await this.db.get(getSql, domain, category);
            if(result) {
                return result;
            }
        } catch (err) {
            console.error(err.message);
        }
        parts = parts.slice(1);
    }

    return null;
};

Lookup.prototype.loadDomainsFile = async function(domainsFile, category) {
    if (!this.initialized) {
        throw Error('Database has not been initialized');
    }
    try {
        const data = fs.readFileSync(`${domainsFile}`);
        const domains = data.toString().split('\n');

        const categorySql = 'INSERT INTO categories(categoryText)' +
            ' SELECT ? WHERE NOT EXISTS(SELECT 1 FROM categories WHERE categoryText = ?);';

        await this.db.run(categorySql, category, category);

        const getCategoryId = 'SELECT id FROM categories WHERE categoryText = ?'

        const categoryId = (await this.db.get(getCategoryId, category)).id;

        const domainSql = 'INSERT INTO domains(domainText, categoryId) VALUES (?, ?);'

        await this.db.run('BEGIN TRANSACTION');
        const stmt = await this.db.prepare(domainSql);

        for(let i = 0; i < domains.length; i++) {
            let domain = domains[i].trim();
            if (domain) {
                if (domain.substring(domain.length-1) === '.') {
                    domain = domain.substring(0,domain.length-1);
                }
                try {
                    await stmt.run(domain, categoryId);
                } catch (err) {
                    if (err.errno !== 19 || err.code !== 'SQLITE_CONSTRAINT') {
                        throw err;
                    }
                }
            }
        }
        await stmt.finalize();

        await this.db.run('END TRANSACTION');

    } catch (err) {
        console.error(err.message);
    }
};

Lookup.prototype.loadDomainsDirectory = async function(directory) {
    if (!this.initialized) {
        throw Error('Database has not been initialized');
    }
    let lists = [];
    let findPromise = new Promise(function(resolve, reject) {
        const finder = find(directory);
        finder.on('file', async function (file, stat) {
            const filename = path.basename(file);
            if (filename === 'domains') {
                let category = file.replace(filename, '').replace(directory, '');
                category = (category.split('/').filter(s => s != '')).join('/');
                lists.push({file: file, category: category});
            }
        });
        finder.on('end', resolve);
        finder.on('error', reject);
    });
    await findPromise;
    for(let i = 0; i < lists.length; i++) {
        const list = lists[i];
        await this.loadDomainsFile(list.file, list.category);
    }
}

module.exports = Lookup;
