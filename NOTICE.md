# Data sources, credits and terms

wxdeck is software you run yourself. It contains no weather data: your own server (or your own phone,
in phone mode) fetches it from the sources below, for your own use. The MIT licence covers wxdeck's
code only. Each data source has its own terms, and you are responsible for following them.

| Source | What wxdeck uses | Terms in short |
|---|---|---|
| [Bureau of Meteorology](https://www.bom.gov.au/copyright) | Radar images, warnings and station observations (from BoM's [anonymous FTP feed](https://www.bom.gov.au/catalogue/anon-ftp.shtml), the website as fallback), radar archive (via NCI) | © Commonwealth of Australia. By default for personal use only; no redistribution or commercial use; radar may need a data licence to publish. Don't run a public wxdeck that serves BoM imagery to others. |
| [Blitzortung.org](https://www.blitzortung.org) / [LightningMaps.org](https://www.lightningmaps.org) | Live lightning | Community network; private, non-commercial use. Ask them before using it in anything public. |
| [Open-Meteo](https://open-meteo.com/en/terms) | Forecasts, forecast maps, ensemble rain ranges, marine, air quality, geocoding | Free for non-commercial use (under 10,000 calls a day); data CC BY 4.0. Ads or subscriptions need a paid plan. |
| [NOAA Himawari on AWS](https://registry.opendata.aws/noaa-himawari/) | Raw Himawari-9 bands | Open data. |
| [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) / [FIRMS](https://firms.modaps.eosdis.nasa.gov/) | Satellite images, coastlines, fire hotspots | Open data; credit NASA. |
| [CIRA SLIDER](https://rammb-slider.cira.colostate.edu/) | GeoColor true colour | Credit CIRA/CSU and JMA. |
| [Aviation Weather Center](https://aviationweather.gov/) | METAR airport reports | US government data. |
| [University of Wyoming](https://weather.uwyo.edu/upperair/sounding.html) | Observed soundings | Credit UWyo. |
| [OpenStreetMap Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | Address search | Light use only, as its policy asks (wxdeck caches results); © OpenStreetMap contributors. |
| [GeoNames](https://www.geonames.org/) / [Natural Earth](https://www.naturalearthdata.com/) | Town names, highways, state borders | CC BY 4.0 / public domain. |
| [Windy Webcams](https://api.windy.com/webcams) | Webcams (optional) | Needs your own free key. |
| [Piper](https://github.com/rhasspy/piper) | Spoken alerts | Check the licence of the voice you choose. |

## Warnings disclaimer

wxdeck's own warnings, watches, storm ratings and nowcasts are automated and **unofficial**. They come
from a hobby algorithm reading public radar images and model data, and they can be wrong, late or
missing. Always follow the Bureau of Meteorology and emergency services. Don't rely on wxdeck for
safety of life or property.
