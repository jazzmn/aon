"use strict";

const _=require('lodash');
const log4js = require("log4js"), log4js_extend = require("log4js-extend");
const os=require('os');
const requestLib = require('request')
const neatCsv = require('neat-csv');
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
	
	logger.info("login to TA-Box: "+config.taBox.baseUrl)
	await reqP({ method: 'POST',
	  url: config.taBox.baseUrl+'/start.html',
	  headers: 
	   { 'content-type': 'application/x-www-form-urlencoded' },
	  form: 
	   { username: config.taBox.username,
		 password: config.taBox.password }
	})
	
	logger.info("get csvData from TA-Box")
	let csvData=await reqP({ method: 'GET',
	  url: config.taBox.baseUrl+'/cgi-bin/getCSV',
	  qs: 
	   { ts_from: 15012938012 } //TODO: params vervollstaendigen
	})
	let data=await neatCsv(csvData)
	logger.debug(csvData)
	
	logger.info("login to dot4SaKpiRepository: "+config.dot4SaKpiRepository.baseUrl)
	let kpiRepLogin=await reqP({ method: 'POST',
	  url: config.dot4SaKpiRepository.baseUrl+'/token',
	  json: true,
	  form: 
	   { 'apiKey': config.dot4SaKpiRepository.apiKey }
	})
	, kpiRepToken=kpiRepLogin.data['access_token']
	
	logger.info("get Dot4 service IDs from dot4SaKpiRepository")
	let allServices=await reqP({ method: 'GET',
	  url: config.dot4SaKpiRepository.baseUrl+'/service',
	  headers: { 'Authorization': 'Bearer '+kpiRepToken },
	  json: true
	})
	, serviceName="Printing FollowMe" //TODO: woher kommt der service name
	, serviceUid=_.get( _.find(allServices.data, { name: 'Printing '+serviceName }), 'uid')
	
	//TODO:
	// calculate kpi
	let calculatedKpi={
		serviceUid
		, value: 1
	}
	
	logger.info("upload new kpi values into dot4SaKpiRepository")
	await reqP({ method: 'POST',
	  url: config.dot4SaKpiRepository.baseUrl+'/service/customkpi',
	  headers: { 'x-api-key': kpiRepToken },
	  form: 
	   { serviceUid: calculatedKpi.serviceUid,
		 volumeTotal: calculatedKpi.value ,
		 volumeColor: calculatedKpi.value } //TODO: woher kommt dieser Key
	})
})().catch(e => {
   logger.error(e)
});