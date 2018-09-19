"use strict";

const _=require('lodash');
const async = require("async");
const log4js = require("log4js"), log4js_extend = require("log4js-extend");
const os=require('os');
const request = require('request')
// const neatCsv = require('neat-csv');
const moment = require('moment');
moment.locale('de')

// const mkdirp = require('mkdirp');
const commandLineArgs = require('command-line-args');

const config = require("./config");

const optionDefinitions = [
  { name: 'daysBack', alias: 'd', type: Number, defaultValue: 1 }
  ,  { name: 'fixedDay', alias: 'f', type: String }
];
const options = commandLineArgs(optionDefinitions);

log4js.configure(config.log4js);
log4js_extend(log4js, {
  path: __dirname,
  format: "(@file:@line:@column)"
});
const logger = log4js.getLogger(os.hostname())
, now=moment();

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
		let taBox=reqOpt.url.indexOf(config.taBox.baseUrl)!=-1
		, myReq=taBox?request_TA:request_proxied
		
		// logger.debug(reqOpt)
		myReq(reqOpt, function (error, response, body) {
			if(error || 
				(taBox && response.statusCode!=200 && response.statusCode!=302) ||
				(!taBox && response.statusCode!=200)
			){
				
				return reject(
					"occured on URL ["+reqOpt.url+"]: ["+
					(error || _.get(body, 'error') || JSON.stringify(response))+']'
				)
			}
			resolve(body)
		})
	})
}

(async () => {
	
	/**
	 * login to TA-Box
	 */
	logger.info("login to TA-Box: "+config.taBox.baseUrl)
	let startUrl=config.taBox.baseUrl+'/cgi-bin/login'
	await reqP({ method: 'POST',
	  url: startUrl,
	  headers: 
	   { 'content-type': 'application/x-www-form-urlencoded' },
	  form: 
	   { username: config.taBox.username,
		 password: config.taBox.password }
	})
	
	// logger.debug(cookieJar.getCookies(config.taBox.baseUrl))
	if(!cookieJar.getCookies(config.taBox.baseUrl).length)
		throw new Error("won't work without cookies")

	/**
	 * load IDs from TA-Box
	 */
	let ta_groupId2printServiceName={}
	,  from_ts=parseInt(moment( now.startOf('day').format() ).format('X'),10)
	let loadIds=await reqP({ method: 'GET',
		url: config.taBox.baseUrl+'/cgi-bin/getJSON',
		json: true,
		gzip: true,
		qs: { 
			view: "vol_group"
			, from_district: 0
			, to_district: 0
			, period: "spec"
			, from_ts //millis/1000 und GMT 0
			, to_ts: from_ts+86399 //millis/1000 und GMT 0
		  }
	})
	_.forEach(loadIds.data, d=>{
		ta_groupId2printServiceName[ d.group_id ] = d.group_name
		logger.debug(d.group_id+" = "+d.group_name)
	})

	
	/**
	 * load data from TA-Box
	 * one request per day
	 */
	logger.info("get data from TA-Box")
	let dataPerDay=await new Promise((resolve, reject)=>{
		let nDays=options.fixedDay?1:options.daysBack+1;
		async.timesLimit(nDays, 1, function(n, next) {
			let workingDay=options.fixedDay ? moment(options.fixedDay) : moment(now).subtract(n,'days');
			workingDay=moment(workingDay.startOf('day').format())
			let from_ts=parseInt(workingDay.format('X'),10)
			
			logger.debug(n+".) loading data for "+workingDay.format('L')+". from_ts: "+from_ts)

			let dailyData={
				day: workingDay
				, data: []
			}
			async.mapValuesLimit(ta_groupId2printServiceName, 1, function (printServiceName, group_id, fecb) {

				request_TA({ method: 'GET',
				  url: config.taBox.baseUrl+'/cgi-bin/getJSON',
				  json: true,
				  gzip: true,
				  qs: { 
					view: "vol_dev_group"
					, from_district: 0
					, period: "spec"
					, from_ts //millis/1000 und GMT 0
					, to_district: 0
					, to_ts: from_ts+86399 //millis/1000 und GMT 0
					// , _: 1536845357333 //millis von einlog-zeit
					, group_id
				  }
				}, function (error, response, body) {
					let err=error
					if(!error && !_.has(body,"data"))
						err="can't load data for ("+workingDay.format('LLL')+")"
						
					// logger.debug(body)
					if(_.some(body.data,{valid_start_ts: ''}))
						throw new Error("invalid start_ts: "+from_ts+ " (type: "+(typeof from_ts)+")")
					
					body.group_name=printServiceName
					
					// if(ta_groupId2printServiceName[group_id] == 'AON Frankfurt') //OUT!!!!!!  && workingDay.format('YYYY-MM-DD')=='2018-09-16'
						// logger.debug(body)
					
					fecb(err,body)
				})
				
			}, function (err, druckerEinerGruppeFuerEinenTag) {

				_.forEach(druckerEinerGruppeFuerEinenTag, g=>{
					let dev_total_vol=0
					, dev_color_vol=0
					
					// if(g.group_name == 'AON Frankfurt') //OUT!!!!!!  && workingDay.format('YYYY-MM-DD')=='2018-09-17'
						// logger.debug(g.data)
						
					_.forEach(g.data, d=>{
						if(d.dev_total_vol)
							dev_total_vol += parseInt(d.dev_total_vol,10)
						
						if(d.dev_color_vol)
							dev_color_vol += parseInt(d.dev_color_vol,10)
					})
					dailyData.data.push({
						"group_total_vol": dev_total_vol
						, "group_name": g.group_name
						, "group_color_vol": dev_color_vol
					})
				})
				// logger.debug(dailyData.data)
					
				next(err, dailyData)
			})
		}, function(err, dailyData) {
			if(err)
				return reject(err)
			resolve(dailyData)
		});
	})
	// logger.debug(dataPerDay)

	/**
	 * login to Dot4 Kpi Repository
	 */
	logger.info("login to dot4SaKpiRepository: "+config.dot4SaKpiRepository.baseUrl)
	let kpiRepLogin=await reqP({ method: 'POST',
	  url: config.dot4SaKpiRepository.baseUrl+'/token',
	  json: true,
	  body: 
	   { 'apiKey': config.dot4SaKpiRepository.apiKey }
	})
	let kpiRepToken=kpiRepLogin.data['access_token']
	
	/**
	 * load Service IDs from Dot4 Kpi Repository
	 */
	logger.info("get Dot4 service IDs from dot4SaKpiRepository")
	let allServices=await reqP({ method: 'GET',
	  url: config.dot4SaKpiRepository.baseUrl+'/service',
	  headers: { 'Authorization': 'Bearer '+kpiRepToken },
	  json: true
	})
	
	/**
	 * remodelling of dataPerDay: we need the data grouped per service
	 */
	let dataPerService={}
	, serviceUid2Name={}
	_.forEach(dataPerDay, d=>{
		//working on day: d.day
		_.forEach(d.data, dataOfService=>{
			let serviceName=dataOfService.group_name
			, serviceUid=_.get( _.find(allServices.data, { name: 'Printing '+serviceName }), 'uid')
			
			if(!serviceUid) 
				throw new Error("no dot4 service found for "+serviceName+". Skipping it for now.")
			
			serviceUid2Name[serviceUid]=serviceName
			
			// logger.debug({serviceName, serviceUid})
			
			if(!dataPerService[serviceUid])
				dataPerService[serviceUid]=[]
			dataPerService[serviceUid].push({
				// timestamp: d.day.format()
				timestamp: moment(d.day).add(1,"days").format() //ToDo: soll ein Tag addiert werden oder ist .utcOffset() korrekt?
				, volumeTotal: dataOfService.group_total_vol
				, volumeColor: dataOfService.group_color_vol
			})
			// logger.debug(_.last(dataPerService[serviceUid]))
		})
	})
	
	/**
	 * upload new kpi values into Dot4 Kpi Repository
	 * (one request per Service with all kpis and days)
	 */
	await new Promise((resolve, reject)=>{
		async.eachOfLimit(dataPerService, 1, function (kpis, serviceUid, next) {
			logger.info("upload new kpi values ("+kpis.length+" days) into dot4SaKpiRepository for service: "+serviceUid2Name[serviceUid]+" ("+serviceUid+")")
			// logger.debug("kpis: "+JSON.stringify(kpis))
			
			request_proxied({ method: 'POST',
			  url: config.dot4SaKpiRepository.baseUrl+'/service/customkpi-collection',
			  headers: { 'Authorization': 'Bearer '+kpiRepToken },
			  json: true,
			  body: 
			   { serviceUid,
				 kpis
			   }
			}, function (error, response, body) {
				let err=error
				if(!error && _.has(body,"error"))
					err=body.error
				
				// logger.debug(body)
				next(err,body)
			})
		}, function (err) {
			if(err)
				return reject(err)
			resolve()
		});
	})

})().catch(e => {
   logger.error(e)
});