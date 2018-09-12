"use strict";

const _=require('lodash');
const log4js = require("log4js"), log4js_extend = require("log4js-extend");
const os=require('os');
const requestLib = require('request')
const azure = require('azure-storage');
const moment = require('moment');
moment.locale('de')

// const mkdirp = require('mkdirp');
// const commandLineArgs = require('command-line-args');

const config = require("./config");

log4js.configure(config.log4js);
log4js_extend(log4js, {
  path: __dirname,
  format: "(@file:@line:@column)"
});
const logger = log4js.getLogger(os.hostname());

const request = requestLib.defaults({jar: true})

const reqP = (reqOpt)=>{
	return new Promise((resolve, reject)=>{
		request(reqOpt, function (error, response, body) {
			if(error)
				return reject(error)
			resolve(body)
		})
	})
}

(async () => {
	
	logger.debug("start login")
	await reqP({ method: 'POST',
	  url: config.taBox.baseUrl+'/start.html',
	  headers: 
	   { 'cache-control': 'no-cache',
		 'content-type': 'application/x-www-form-urlencoded' },
	  form: 
	   { username: config.taBox.username,
		 password: config.taBox.password }
	})
	
	logger.debug("get csvData")
	let csvData=await reqP({ method: 'GET',
	  url: config.taBox.baseUrl+'/cgi-bin/getCSV',
	  qs: 
	   { ts_from: 15012938012 }
	})
	logger.debug(csvData)
	
	logger.debug("start uploading to storage")
	let azureFileService = (config.azure.connectionString) ? 
		azure.createFileService(config.azure.connectionString) : 
		azure.createFileService(config.azure.accountName, config.azure.accountKey)
	, shareName=config.azure.shareName
	, dirName=config.azure.dirName
	, filename=moment().format('YYYY-MM-DD')
	
	//lege share an, falls nicht existiert
	await new Promise((resolve, reject)=> {
		azureFileService.createShareIfNotExists(shareName, function(error, result, response) {
		  if (error) 
			return reject(error);
		  
		  logger.debug("azure storage ok: "+shareName)
		  resolve();
		});
	});
	
	//lege directory an, falls nicht existiert
	await new Promise((resolve, reject)=> {
		azureFileService.createDirectoryIfNotExists(shareName, dirName, function(error, result, response) {
		  if (error) 
			return reject(error);
		  
		  logger.debug("azure directory ok: "+dirName)
		  resolve();
		});
	});
	
	//Upload to Storage
	await new Promise((resolve, reject)=> {
	azureFileService.createFileFromText(shareName, dirName, filename, csvData, function(error, result, response) {
		  if (error) 
			return reject(error);
		  
		  logger.debug("copy to azure storage succeeded: "+filename)
		  resolve();
		});
	});
					
				
})().catch(e => {
   logger.error(e)
});