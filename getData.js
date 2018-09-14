"use strict";

const _=require('lodash');
const log4js = require("log4js"), log4js_extend = require("log4js-extend");
const os=require('os');
const request = require('request')
// const neatCsv = require('neat-csv');
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

const cookieJar=request.jar()
, request_TA = request.defaults({
	jar: cookieJar
})
, request_proxied = request.defaults({
	'proxy': config.proxy
	, strictSSL: false
})

const reqP = (reqOpt)=>{
	return new Promise((resolve, reject)=>{
		let myReq=reqOpt.url.indexOf(config.taBox.baseUrl)!=-1?request_TA:request_proxied
		
		// logger.debug(reqOpt)
		myReq(reqOpt, function (error, response, body) {
			if(error || (response.statusCode!=200 && response.statusCode!=302))
				return reject(
					"occured on URL "+reqOpt.url+", "+
					(error || JSON.stringify(response))
				)
			
			// logger.debug(response.headers['set-cookie'])
			resolve(body)
		})
	})
}

(async () => {
	
	logger.info("login to TA-Box: "+config.taBox.baseUrl)
	let startUrl=config.taBox.baseUrl+'/cgi-bin/login'
	await reqP({ method: 'POST',
	  url: startUrl,
	  // jar: cookieJar,
	  headers: 
	   { 'content-type': 'application/x-www-form-urlencoded' },
	  form: 
	   { username: config.taBox.username,
		 password: config.taBox.password }
	})
	
	logger.debug(cookieJar.getCookies(config.taBox.baseUrl))
	if(!cookieJar.getCookies(config.taBox.baseUrl).length)
		throw new Error("won't work without cookies")

		
	logger.info("get csvData from TA-Box")
	let data=await reqP({ method: 'GET',
	  url: config.taBox.baseUrl+'/cgi-bin/getJSON',
	  // jar: cookieJar,
	  json: true,
	  qs: { 
		view: "vol_group"
		// , from_district: 0
		, period: "spec"
		, from_ts: 1536703200 //millis/1000 und GMT 0
		// , to_district: 0
		, to_ts: 1536789599 //millis/1000 und GMT 0
		// , _: 1536845357333 //millis von einlog-zeit
	  } //TODO: millis auf letzten oder gewuenschten tag umstellen
	})

	logger.debug(data)
	/*
	{
    "data": [
        {
            "group_total_vol": "216400",
            "group_name": "AON Hamburg",
            "group_id": "1",
            "filter": ",,",
            "group_color_vol": "71003",
            "groupfilter": ""
        },
	*/
	
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
	, serviceName=_.get(data,"data[0].group_name")
	, serviceUid=_.get( _.find(allServices.data, { name: 'Printing '+serviceName }), 'uid')
	
	logger.info("upload new kpi values into dot4SaKpiRepository")
	await reqP({ method: 'POST',
	  url: config.dot4SaKpiRepository.baseUrl+'/service/customkpi',
	  headers: { 'x-api-key': kpiRepToken },
	  form: 
	   { serviceUid,
		 volumeTotal: _.get(data,"data[0].group_total_vol") ,
		 volumeColor: _.get(data,"data[0].group_color_vol") } //TODO: fuer alle data[i]
	})
})().catch(e => {
   logger.error(e)
});