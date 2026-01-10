import React, { useState } from 'react';
import axios from 'axios';
import { subDays, subYears, format } from 'date-fns';
import './HeatPumpCalculator.css';

interface WeatherData {
  hourly: {
    time: string[];
    temperature_2m: number[];
  };
}

interface GeoResult {
  results?: Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
  }>;
}

const HeatPumpCalculator: React.FC = () => {
  // Defaults
  const today = new Date();
  const yesterday = subDays(today, 1);
  const oneYearAgo = subYears(yesterday, 1);

  const [eff, setEff] = useState<number>(0.5);
  const [startDate, setStartDate] = useState<string>(format(oneYearAgo, 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(yesterday, 'yyyy-MM-dd'));
  const [tempInnen, setTempInnen] = useState<number>(20.0);
  const [paramA, setParamA] = useState<number>(-1.0);
  const [paramB, setParamB] = useState<number>(22.0);
  const [area, setArea] = useState<number>(100.0);
  const [uVal, setUVal] = useState<number>(0.5);
  
  const [locationName, setLocationName] = useState<string>('Hamburg');
  const [lat, setLat] = useState<number>(53.5511);
  const [lon, setLon] = useState<number>(9.9937);
  
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<{
    hoursTotal: number;
    hoursHeating: number;
    heatKWh: number;
    elecKWh: number;
    jaz: number;
  } | null>(null);
  
  const [error, setError] = useState<string>('');

  const handleLocationSearch = async () => {
    if (!locationName) return;
    
    // Check if lat,lon format
    if (locationName.includes(',')) {
      const parts = locationName.split(',');
      if (parts.length === 2) {
        const p1 = parseFloat(parts[0]);
        const p2 = parseFloat(parts[1]);
        if (!isNaN(p1) && !isNaN(p2)) {
          setLat(p1);
          setLon(p2);
          setError('');
          alert(`Koordinaten gesetzt: ${p1}, ${p2}`);
          return;
        }
      }
    }

    try {
      const url = "https://geocoding-api.open-meteo.com/v1/search";
      const resp = await axios.get<GeoResult>(url, {
        params: { name: locationName, count: 1, language: 'de', format: 'json' }
      });
      
      if (resp.data.results && resp.data.results.length > 0) {
        const first = resp.data.results[0];
        setLat(first.latitude);
        setLon(first.longitude);
        setError('');
        alert(`Gefunden: ${first.name}, ${first.country} (${first.latitude}, ${first.longitude})`);
      } else {
        setError("Ort nicht gefunden.");
      }
    } catch (e) {
      setError("Fehler bei der Ortssuche.");
      console.error(e);
    }
  };

  const calculate = async () => {
    setLoading(true);
    setError('');
    setResult(null);

    if (new Date(startDate) >= new Date(endDate)) {
        setError("Startdatum muss vor Enddatum liegen.");
        setLoading(false);
        return;
    }

    try {
      const url = "https://archive-api.open-meteo.com/v1/archive";
      const params = {
        latitude: lat,
        longitude: lon,
        start_date: startDate,
        end_date: endDate,
        hourly: "temperature_2m"
      };

      const resp = await axios.get<WeatherData>(url, { params });
      const temps = resp.data.hourly.temperature_2m;
      
      if (!temps || temps.length === 0) {
        setError("Keine Wetterdaten empfangen.");
        setLoading(false);
        return;
      }

      let totalHeatWh = 0.0;
      let totalElecWh = 0.0;
      let heatHours = 0;

      for (const tOut of temps) {
        if (tOut === null || tOut === undefined) continue;
        
        // Heizlast Q = U * A * (Ti - Ta)
        if (tOut < tempInnen) {
          const qLoad = uVal * area * (tempInnen - tOut);
          
          // Vorlauf
          const tVorlauf = paramA * (tOut - tempInnen) + paramB;
          
          const tVorlaufK = tVorlauf + 273.15;
          const tOutK = tOut + 273.15;
          
          let copCarnot = 0;
          
          // Physik check
          if (tVorlaufK <= tOutK) {
             // Fallback for weird optimization or bad params
             copCarnot = 99999.0;
          } else {
             copCarnot = tVorlaufK / (tVorlaufK - tOutK);
          }
          
          let copReal = eff * copCarnot;
          if (copReal < 1.0) copReal = 1.0;
          
          // Max limit to avoid infinity
          if (copReal > 20000) {
            // Near infinite efficiency -> 0 electricity
            totalHeatWh += qLoad;
            // totalElecWh += 0;
          } else {
             const pElec = qLoad / copReal;
             totalHeatWh += qLoad;
             totalElecWh += pElec;
          }
          
          heatHours++;
        }
      }
      
      const heatKWh = totalHeatWh / 1000.0;
      const elecKWh = totalElecWh / 1000.0;
      const jaz = elecKWh > 0 ? heatKWh / elecKWh : 0.0;

      setResult({
        hoursTotal: temps.length,
        hoursHeating: heatHours,
        heatKWh,
        elecKWh,
        jaz
      });

    } catch (e) {
      setError("Fehler beim Abrufen der Wetterdaten oder Berechnen.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="calculator-box">
      <div className="input-group">
        <label>Ort (Name oder lat,lon):</label>
        <div style={{display: 'flex', gap: '8px'}}>
          <input 
            type="text" 
            value={locationName} 
            onChange={(e) => setLocationName(e.target.value)} 
          />
          <button onClick={handleLocationSearch}>Suchen</button>
        </div>
        <small>Lat: {lat}, Lon: {lon}</small>
      </div>

      <div className="grid-2">
        <div className="input-group">
           <label>Effizienz (0-1):</label>
           <input type="number" step="0.05" value={eff} onChange={(e) => setEff(parseFloat(e.target.value))} />
        </div>
        <div className="input-group">
           <label>Innentemp (°C):</label>
           <input type="number" value={tempInnen} onChange={(e) => setTempInnen(parseFloat(e.target.value))} />
        </div>
      </div>
      
      <div className="grid-2">
         <div className="input-group">
           <label>Startdatum:</label>
           <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
         </div>
         <div className="input-group">
           <label>Enddatum:</label>
           <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
         </div>
      </div>

      <div className="input-header">Heizkurve: T_vl = a * (Ta - Ti) + b</div>
      <div className="grid-2">
         <div className="input-group">
           <label>Parameter a:</label>
           <input type="number" step="0.1" value={paramA} onChange={(e) => setParamA(parseFloat(e.target.value))} />
         </div>
         <div className="input-group">
           <label>Parameter b (°C):</label>
           <input type="number" value={paramB} onChange={(e) => setParamB(parseFloat(e.target.value))} />
         </div>
      </div>

      <div className="input-header">Gebäude</div>
      <div className="grid-2">
         <div className="input-group">
           <label title="Wände + Dach + Fenster + Boden">Hüllfläche A (m²):</label>
           <input type="number" value={area} onChange={(e) => setArea(parseFloat(e.target.value))} />
         </div>
         <div className="input-group">
           <label>U-Wert (W/m²K):</label>
           <input type="number" step="0.1" value={uVal} onChange={(e) => setUVal(parseFloat(e.target.value))} />
         </div>
      </div>
      
      <button className="calc-btn" onClick={calculate} disabled={loading}>
        {loading ? 'Berechne...' : 'Berechnen'}
      </button>

      {error && <div className="error">{error}</div>}

      {result && (
        <div className="result-box">
          <h3>Ergebnis</h3>
          <p>Gesamte Stunden: <strong>{result.hoursTotal}</strong></p>
          <p>Heizstunden: <strong>{result.hoursHeating}</strong></p>
          <p>Heizwärmebedarf: <strong>{result.heatKWh.toFixed(2)} kWh</strong></p>
          <p>Stromverbrauch: <strong>{result.elecKWh.toFixed(2)} kWh</strong></p>
          <p className="big-jaz">JAZ: {result.jaz.toFixed(2)}</p>
        </div>
      )}
    </div>
  );
};

export default HeatPumpCalculator;
