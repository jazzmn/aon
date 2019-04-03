"use strict";

const _=require('lodash')
, async = require("async")
, cheerio = require('cheerio')
, log4js = require("log4js"), log4js_extend = require("log4js-extend")
// , os=require('os');
, fs=require('fs')
, request = require('request')
, commandLineArgs = require('command-line-args')
, csvWriter = require('csv-write-stream')
, moment = require('moment')
;

moment.locale('de')

const config = require("./config");

const optionDefinitions = [
  { name: 'daysBack', alias: 'd', type: Number, defaultValue: 1 }
  , { name: 'fixedDay', alias: 'f', type: String }
  , { name: 'csvExport', alias: 'c', type: Boolean }
  , { name: 'suppressDot4Upload', alias: 's', type: Boolean }
];
const options = commandLineArgs(optionDefinitions);

log4js.configure(config.log4js);
log4js_extend(log4js, {
  path: __dirname,
  format: "(@file:@line:@column)"
});
const logger = log4js.getLogger()
, alertLogger = log4js.getLogger("alerts")
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
	
	let writer = csvWriter({newline: '\r\n'})
	/** open csv */
	if(options.csvExport){
		writer.pipe(fs.createWriteStream('out.csv'))
	}

	/**
	 * login to TA-Box
	 */
	logger.info("login to TA-Box: "+config.taBox.baseUrl)
	alertLogger.info("login to TA-Box")
	
	await reqP({ method: 'POST',
	  url: config.taBox.baseUrl+'/cgi-bin/login',
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
	 * set columns to be shown in view
	 */
	await reqP({ method: 'POST',
	  url: config.taBox.baseUrl+'/cgi-bin/saveView',
	  headers: 
	   { 'content-type': 'application/x-www-form-urlencoded' },
	  form: 
	   { 
		"view": "vol_dev_group"
		, "id": null
		// , "name": "AON Hamburg"
		, "style": "sm"
		, "save": "view"
		, "fields": "dev_name,dev_serial,vol_from_ts,vol_c1_from,vol_to_ts,vol_c1_to,dev_total_vol,dev_color_vol"
	   }
	})
	
	
	
	/**
	 * load IDs from TA-Box
	 */
	let ta_groupId2printServiceName={}
	,  from_ts=parseInt(moment( now.startOf('day').format() ).format('X'),10)
	logger.info("get available IDs and location names from TA-Box")
/*	//Alter CODE, geht nicht, solange in Gruppen Volumen nur 0 eingetragen
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
*/
	let $=cheerio.load( await reqP({ 
		method: 'GET'
		, url: config.taBox.baseUrl+'/cgi-bin/statistics'
	}))
	$('li','#tabnavi_volumes').each(function(i, elem) {
	  let group_id=$(this).attr('id')
	  , group_name=$(this).text()
	  , group_id_num
	  ;
	  if(/tab-group-(\d+)/.test(group_id)){
		  group_id_num=RegExp.$1
		  ta_groupId2printServiceName[group_id_num]=group_name
	  }
	  logger.debug(`group_id_num: ${group_id_num}, group_name: ${group_name}`)
	});
	
	/**
	 * load data from TA-Box
	 * one request per day
	 */
	logger.info("get data from TA-Box")
	alertLogger.info("get data from TA-Box")
	let collectAlertLogger=[]
	, dataCnt=0
	, dataPerDay=await new Promise((resolve, reject)=>{
		let nDays=options.fixedDay?1:options.daysBack+1
		;
		async.timesLimit(nDays, 1, function(n, next) {
			let workingDay=options.fixedDay ? moment(options.fixedDay) : moment(now).subtract(n,'days');
			workingDay=moment(workingDay.startOf('day').format())
			let from_ts=parseInt(workingDay.format('X'),10)
			;
			
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
					
					// if(ta_groupId2printServiceName[group_id].indexOf(' Frankfurt')!=-1) //OUT!!!!!!  && workingDay.format('YYYY-MM-DD')=='2018-09-16'
						 // logger.debug(body)
					
					fecb(err,body)
				})
				
			}, function (err, druckerEinerGruppeFuerEinenTag) {

				_.forEach(druckerEinerGruppeFuerEinenTag, g=>{
					let dev_total_vol=0
					, dev_color_vol=0
					
					// if(g.group_name.indexOf('Unita')!=-1) //OUT!!!!!!  && workingDay.format('YYYY-MM-DD')=='2018-09-17'
						// logger.debug(g.data) //OUT!!!
						
					_.forEach(g.data, d=>{
						if(_.has(d,'dev_total_vol')){
							if(d.dev_total_vol)
								dev_total_vol += parseInt(d.dev_total_vol,10)
						} else {
							const msg=`Beim Standort "${g.group_name} fehlt die Angabe von dev_total_vol. Ansicht in TA-Box geaendert?`
							logger.warn(msgmsg)
							collectAlertLogger.push({msg, level: "warn"})
						}
						
						if(_.has(d,'dev_color_vol')){
							if(d.dev_color_vol)
								dev_color_vol += parseInt(d.dev_color_vol,10)
						} else {
							const msg=`Beim Standort "${g.group_name} fehlt die Angabe von dev_color_vol. Ansicht in TA-Box geaendert?`
							logger.warn(msg)
							collectAlertLogger.push({msg, level: "warn"})
						}
					})
					dailyData.data.push({
						"group_total_vol": dev_total_vol
						, "group_name": g.group_name
						, "group_color_vol": dev_color_vol
					})
				})
				dataCnt+=_.get(dailyData,"data.length")||0
				
				if(n===0)
					logger.debug(dailyData.data)
					
				next(err, dailyData)
			})
		}, function(err, dailyData) {
			if(err)
				return reject(err)
			resolve(dailyData)
		});
	})
	// logger.debug(dataPerDay)
	
	collectAlertLogger=_.uniqBy(collectAlertLogger, 'msg')
	if(collectAlertLogger.length) {
		const numOutputsWanted=3
		for(let i=0;i<numOutputsWanted; i++){
			const {msg, level}=collectAlertLogger[i]
			alertLogger[level](msg)
		}
		if(collectAlertLogger.length>1)
			alertLogger.warn(`${collectAlertLogger.length-numOutputsWanted} weitere Meldungen zu fehlenden Daten!`)
	}
	collectAlertLogger=[]
	
	if(!dataCnt){
		throw new Error("no data found. cannot upload anything.")
	}

	/**
	 * login to Dot4 Kpi Repository
	 */
	logger.info("login to dot4SaKpiRepository: "+config.dot4SaKpiRepository.baseUrl)
	alertLogger.info("login to dot4SaKpiRepository")
	
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
	alertLogger.info("get Dot4 service IDs from dot4SaKpiRepository")
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
			
			if(!serviceUid) {
				const err="no dot4 service found for "+serviceName+". Skipping it for now."
				logger.error(err)
				collectAlertLogger.push({msg: err, level: "error"})
				return;
			}
			
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
			
			/** write CSV */
			if(options.csvExport){
				writer.write({
					serviceName, serviceUid, date: d.day.format("YYYY-MM-DD")
					, volumeTotal: dataOfService.group_total_vol
					, volumeColor: dataOfService.group_color_vol
				})
			}
		})
	})
	
	_.forEach(_.uniqBy(collectAlertLogger, 'msg'), log=>alertLogger[log.level](log.msg))
	collectAlertLogger=[]
	
	/** close CSV */
	if(options.csvExport){
		writer.end()
	}
	
	/**
	 * upload new kpi values into Dot4 Kpi Repository
	 * (one request per Service with all kpis and days)
	 */
	if(!options.suppressDot4Upload){
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
	}
	
	const fMsg=`program finished (${dataCnt} new data sets).`
	logger.info(fMsg)
	alertLogger.info(fMsg)
})().catch(e => {
   logger.error(e)
   alertLogger.error(e)
});