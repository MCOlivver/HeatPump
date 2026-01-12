import React, { useState, useEffect, useRef } from 'react';
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

// Hook to persist state in localStorage
function useStickyState<T>(defaultValue: T, key: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stickyValue = window.localStorage.getItem(key);
      return stickyValue !== null ? JSON.parse(stickyValue) : defaultValue;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Error writing localStorage key "${key}":`, error);
    }
  }, [key, value]);

  return [value, setValue];
}

const HeatPumpCalculator: React.FC = () => {
  // Defaults
  const today = new Date();
  const yesterday = subDays(today, 1);
  const oneYearAgo = subYears(yesterday, 1);
  // Remove hours for date comparison
  const todayStart = new Date(today);
  todayStart.setHours(0,0,0,0);

  const [eff, setEff] = useStickyState<number>(0.5, 'hp_eff');
  const [startDate, setStartDate] = useState<string>(format(oneYearAgo, 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(yesterday, 'yyyy-MM-dd'));
  const [tempInnen, setTempInnen] = useStickyState<number>(20.0, 'hp_tempInnen');
  const [paramA, setParamA] = useStickyState<number>(1.0, 'hp_paramA');
  const [paramB, setParamB] = useStickyState<number>(22.0, 'hp_paramB');
  const [area, setArea] = useStickyState<number>(100.0, 'hp_area');
  const [uVal, setUVal] = useStickyState<number>(0.5, 'hp_uVal');

  const [calcMode, setCalcMode] = useStickyState<'physics' | 'consumption'>('physics', 'hp_calcMode');
  const [fuelType, setFuelType] = useStickyState<'gas' | 'oil'>('gas', 'hp_fuelType');
  const [fuelAmount, setFuelAmount] = useStickyState<number>(15000, 'hp_fuelAmount');
  const [oldEff, setOldEff] = useStickyState<number>(0.85, 'hp_oldEff');
  
  const [locationName, setLocationName] = useStickyState<string>('Hamburg', 'hp_locationName');
  const [lat, setLat] = useStickyState<number>(53.5511, 'hp_lat');
  const [lon, setLon] = useStickyState<number>(9.9937, 'hp_lon');
  
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<{
    hoursTotal: number;
    hoursHeating: number;
    heatKWh: number;
    elecKWh: number;
    jaz: number;
    maxHeatLoadW: number;
    maxHeatDate: string;
    maxElecLoadW: number;
    maxElecDate: string;
    maxElecTemp: number;
    startDate: string; 
    endDate: string;
  } | null>(null);
  
  // Date validation
  const dStart = new Date(startDate);
  const dEnd = new Date(endDate);
  
  const isStartValid = dStart < todayStart;
  const isEndValid = dEnd < todayStart && dStart <= dEnd;
  const isDateRangeValid = isStartValid && isEndValid;

  const [error, setError] = useState<string>('');
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result && resultRef.current) {
        resultRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [result]);

  const formatNum = (val: number) => {
    return val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const formatDateLocale = (dateStr: string) => {
      // Expects YYYY-MM-DDT... or YYYY-MM-DD
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('de-DE'); // e.g. 11.1.2025
  };
  
  const formatDateTimeLocale = (dateTimeStr: string) => {
      // maxElecDate comes as ISO string "2024-01-15T06:00" from API. 
      // We want something locale friendly
      const d = new Date(dateTimeStr);
      if (isNaN(d.getTime())) return dateTimeStr;
      return d.toLocaleString('de-DE'); 
  };
  
  // Validation style helper
  const getStyle = (valid: boolean) => {
      return valid ? {} : { border: '2px solid red', backgroundColor: '#ffeaea' };
  };

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

  const restoreDefaults = () => {
      setEff(0.5);
      setTempInnen(20.0);
      setParamA(1.0);
      setParamB(22.0);
      setArea(100.0);
      setUVal(0.5);
      setCalcMode('physics');
      setFuelType('gas');
      setFuelAmount(15000);
      setOldEff(0.85);
      setLocationName('Hamburg');
      setLat(53.5511);
      setLon(9.9937);
      // Dates are not sticky, so we can leave them or reset them too if desired
      // setStartDate(format(oneYearAgo, 'yyyy-MM-dd'));
      // setEndDate(format(yesterday, 'yyyy-MM-dd'));
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
      
      let maxHeatLoadW = 0.0;
      let maxHeatDate = '-';
      let maxElecLoadW = 0.0;
      let maxElecDate = '-';
      let maxElecTemp = 0.0;

      // 1. First Pass: Calculate total "Degree Hours" if in consumption mode
      let k_load = 0; // W/K (Conductance)
      
      if (calcMode === 'consumption') {
         let sumDegreeHours = 0;
         for (const tOut of temps) {
             if (tOut !== null && tOut < tempInnen) {
                 sumDegreeHours += (tempInnen - tOut);
             }
         }
         
         if (sumDegreeHours === 0) {
           setError("Keine Heizstunden im Zeitraum. Berechnung aus Verbrauch nicht möglich.");
           setLoading(false);
           return;
         }
         
         // Total Heat Demand (kWh) = Fuel (kWh) * Efficiency
         // Fuel kWh conversion:
         // Gas: kWh -> kWh
         // Oil: Liters -> kWh (~10 kWh/L)
         let fuelKWh = fuelAmount;
         if (fuelType === 'oil') {
             fuelKWh = fuelAmount * 10.0; 
         }
         
         const totalHeatDemandKWh = fuelKWh * oldEff;
         
         // k_load [W/K] = (TotalHeat [Wh]) / (SumDeltaT [K*h])
         //              = (TotalHeatKWh * 1000) / sumDegreeHours
         k_load = (totalHeatDemandKWh * 1000.0) / sumDegreeHours;
         
      } else {
         // Physics Mode: k_load = U * A
         k_load = uVal * area;
      }

      for (let i = 0; i < temps.length; i++) {
        const tOut = temps[i];
        if (tOut === null || tOut === undefined) continue;
        
        // Heizlast Q = k_load * (Ti - Ta)
        if (tOut < tempInnen) {
          const qLoad = k_load * (tempInnen - tOut);
          
          if (qLoad > maxHeatLoadW) {
             maxHeatLoadW = qLoad;
             maxHeatDate = resp.data.hourly.time[i];
          }

          // Vorlauf
          const tVorlauf = paramA * (tempInnen - tOut) + paramB;
          
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
          
          let pElec = 0.0;
          // Max limit to avoid infinity
          if (copReal > 20000) {
            // Near infinite efficiency -> 0 electricity
            pElec = 0.0;
          } else {
             pElec = qLoad / copReal;
          }
            
          totalHeatWh += qLoad;
          totalElecWh += pElec;
          heatHours++;
          
          if (pElec > maxElecLoadW) {
             maxElecLoadW = pElec;
             maxElecDate = resp.data.hourly.time[i];
             maxElecTemp = tOut;
          }
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
        jaz,
        maxHeatLoadW,
        maxHeatDate: maxHeatDate.replace('T', ' '),
        maxElecLoadW,
        maxElecDate: maxElecDate.replace('T', ' '),
        maxElecTemp,
        startDate: startDate,
        endDate: endDate
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
        <label>Ort:</label>
        <div style={{display: 'flex', gap: '8px'}}>
          <input 
            type="text" 
            value={locationName} 
            onChange={(e) => setLocationName(e.target.value)} 
          />
          <button onClick={handleLocationSearch}>Suchen</button>
        </div>
        <small>Breite: {lat}, Länge: {lon}</small>
      </div>

      <div className="grid-2">
        <div className="input-group">
           <label>Effizienz (0-1):</label>
           <input type="number" step="0.05" value={eff} onChange={(e) => setEff(parseFloat(e.target.value))} />
           <small style={{display: 'block', marginTop: '4px', color: '#666'}}>typischerweise 0,5 für Luft-Wasser-Wärmepumpe</small>
        </div>
        <div className="input-group">
           <label>Innentemp (°C) T_innen:</label>
           <input type="number" value={tempInnen} onChange={(e) => setTempInnen(parseFloat(e.target.value))} />
        </div>
      </div>
      
      <div className="grid-2">
         <div className="input-group">
           <label>Startdatum:</label>
           <input 
             type="date" 
             value={startDate} 
             onChange={(e) => setStartDate(e.target.value)} 
             style={getStyle(isStartValid)}
           />
           <small style={{display: 'block', marginTop: '4px', color: isStartValid ? '#666' : 'red'}}>
               &lt; heute
           </small>
         </div>
         <div className="input-group">
           <label>Enddatum:</label>
           <input 
             type="date" 
             value={endDate} 
             onChange={(e) => setEndDate(e.target.value)} 
             style={getStyle(isEndValid)}
            />
            <small style={{display: 'block', marginTop: '4px', color: isEndValid ? '#666' : 'red'}}>
               Startdatum &lt;= Enddatum &lt; heute
            </small>
         </div>
      </div>

      <div className="input-header">Heizkurve: T_vorlauf = a*(T_innen - T_aussen) + b</div>
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

      <div className="input-group">
        <label>Berechnungsmodus:</label>
        <div className="radio-group">
            <label>
                <input type="radio" checked={calcMode === 'physics'} onChange={() => setCalcMode('physics')} />
                Bauphysik (U * A)
            </label>
            <label>
                <input type="radio" checked={calcMode === 'consumption'} onChange={() => setCalcMode('consumption')} />
                Verbrauch (Gas/Öl)
            </label>
        </div>
      </div>

      <div className="input-header">Gebäude & Heizlast</div>
      
      {calcMode === 'physics' ? (
        <div className="grid-2">
            <div className="input-group">
            <label title="Außenwände + Dach + Fenster + Boden. Typischerweise ca. 3 * Wohnfläche">Hüllfläche A (m²):</label>
            <input type="number" value={area} onChange={(e) => setArea(parseFloat(e.target.value))} />
            <small style={{display: 'block', marginTop: '4px', color: '#666'}}>typischerweise ca. 3*Wohnfläche</small>
            </div>
            <div className="input-group">
            <label>Wärmedurchgangskoeffizient U (W/m²K):</label>
            <input type="number" step="0.1" value={uVal} onChange={(e) => setUVal(parseFloat(e.target.value))} />
            </div>
        </div>
      ) : (
        <div className="consumption-box">
             <div className="input-group">
                <label>Brennstoff:</label>
                <select value={fuelType} onChange={(e) => setFuelType(e.target.value as 'gas' | 'oil')}>
                    <option value="gas">Gas (kWh)</option>
                    <option value="oil">Öl (Liter)</option>
                </select>
             </div>
             <div className="input-group">
                <label>Verbrauch ({fuelType === 'gas' ? 'kWh' : 'Liter'}):</label>
                <input type="number" value={fuelAmount} onChange={(e) => setFuelAmount(parseFloat(e.target.value))} />
             </div>
             <div className="input-group">
                <label title="Wirkungsgrad der alten Heizung">Nutzungsgrad Alt-Anlage (0-1):</label>
                <input type="number" step="0.05" value={oldEff} onChange={(e) => setOldEff(parseFloat(e.target.value))} />
             </div>
        </div>
      )}
      
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
        <button className="calc-btn" onClick={calculate} disabled={loading || !isDateRangeValid} style={{ flex: 1, opacity: (loading || !isDateRangeValid) ? 0.6 : 1 }}>
            {loading ? 'Berechne...' : 'Berechnen'}
        </button>
        <button onClick={restoreDefaults} style={{ backgroundColor: '#666', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer' }}>
            Standardwerte
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {result && (
        <div className="result-box" ref={resultRef}>
          <h3>Ergebnis</h3>
          <p style={{marginBottom: '15px'}}>Berechnungszeitraum {formatDateLocale(result.startDate)} bis {formatDateLocale(result.endDate)}</p>
          <p>Gesamte Stunden: <strong>{result.hoursTotal}</strong></p>
          <p>Heizstunden: <strong>{result.hoursHeating}</strong></p>
          <p>Heizwärmebedarf: <strong>{formatNum(result.heatKWh)} kWh</strong></p>
          <p>Stromverbrauch: <strong>{formatNum(result.elecKWh)} kWh</strong></p>
          
          <div style={{margin: '15px 0', borderTop: '1px solid #ccc', paddingTop: '10px'}}>
              <p>Max. Heizlast: <strong>{formatNum(result.maxHeatLoadW / 1000)} kW</strong></p>
              <p>Max. elektr. Leistung: <strong>{formatNum(result.maxElecLoadW / 1000)} kW</strong> <br/>
                 <small>am {formatDateTimeLocale(result.maxElecDate)} ({formatNum(result.maxElecTemp)} °C)</small>
              </p>
          </div>

          <p className="big-jaz">Arbeitszahl (COP): {formatNum(result.jaz)}</p>
        </div>
      )}

      <div style={{ marginTop: '30px', textAlign: 'center', fontSize: '0.8rem', color: '#999' }}>
        v1.3 (12.01.2025)
      </div>
    </div>
  );
};

export default HeatPumpCalculator;
