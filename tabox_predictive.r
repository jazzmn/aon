library(forecast)

tabox <- read.csv(file="/tmp/AON_printerData.csv", header=TRUE, sep=",")
volPerDay <- aggregate(volumeTotal ~ date, data = tabox, sum)

#langfristig
tats <-ts(volPerDay[,2], frequency = 365)
plot( stl(tats, s.window="period") )

#kurzfristig
tats <-ts(tail(volPerDay[,2], 28), frequency = 7)
plot( stl(tats, s.window="period") )


#http://robjhyndman.com/hyndsight/dailydata/
y<-ts( tail(volPerDay[,2], 70) ,frequency = 7) #nur 4 wochen
tafit <- ets(y, lambda=0) #lambda gibt minimum an: https://robjhyndman.com/hyndsight/forecasting-within-limits/
fc <- forecast(tafit)
plot(fc)

#When the time series is long enough to take in more than a year, then it may be necessary to allow for annual
#seasonality as well as weekly seasonality. In that case, a multiple seasonal model such as TBATS is required.

yLong <- msts(volPerDay[,2], seasonal.periods=c(7,365.25))
tafitLong <- tbats(yLong)
fcL <- forecast(tafitLong)
plot(fcL)