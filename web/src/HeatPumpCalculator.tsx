import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { subDays, subYears, addDays, format } from 'date-fns';
import './HeatPumpCalculator.css';

interface WeatherData {
  hourly: {
    time: string[];
    temperature_2m: number[];
  };
}

interface LocationResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

interface GeoResult {
  results?: LocationResult[];
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
  const oneYearAgo = addDays(subYears(yesterday, 1), 1);
  // Remove hours for date comparison
  const todayStart = new Date(today);
  todayStart.setHours(0,0,0,0);

  const [eff, setEff] = useStickyState<number>(0.5, 'hp_eff');
  const [startDate, setStartDate] = useState<string>(format(oneYearAgo, 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(yesterday, 'yyyy-MM-dd'));

  // Heating Period (Day/Month)
  const [heatStartD, setHeatStartD] = useStickyState<number>(1, 'hp_heatStartD');
  const [heatStartM, setHeatStartM] = useStickyState<number>(10, 'hp_heatStartM'); // Oct
  const [heatEndD, setHeatEndD] = useStickyState<number>(30, 'hp_heatEndD');
  const [heatEndM, setHeatEndM] = useStickyState<number>(4, 'hp_heatEndM');   // Apr

  const [tempInnen, setTempInnen] = useStickyState<number>(20.0, 'hp_tempInnen');
  const [paramA, setParamA] = useStickyState<number>(1.0, 'hp_paramA');
  const [paramB, setParamB] = useStickyState<number>(22.0, 'hp_paramB');

  const [curveMode, setCurveMode] = useStickyState<'params' | 'points'>('params', 'hp_curveMode');
  // Point 1 (Start/Fußpunkt)
  const [p1Out, setP1Out] = useStickyState<number>(20, 'hp_p1Out');
  const [p1Flow, setP1Flow] = useStickyState<number>(25, 'hp_p1Flow');
  // Point 2 (End/Endpunkt)
  const [p2Out, setP2Out] = useStickyState<number>(-15, 'hp_p2Out');
  const [p2Flow, setP2Flow] = useStickyState<number>(55, 'hp_p2Flow');

  const [area, setArea] = useStickyState<number>(100.0, 'hp_area');
  const [uVal, setUVal] = useStickyState<number>(0.5, 'hp_uVal');

  const [calcMode, setCalcMode] = useStickyState<'physics' | 'consumption'>('physics', 'hp_calcMode');
  const [fuelType, setFuelType] = useStickyState<'gas' | 'oil'>('gas', 'hp_fuelType');
  const [fuelAmount, setFuelAmount] = useStickyState<number>(15000, 'hp_fuelAmount');
  const [oldEff, setOldEff] = useStickyState<number>(0.85, 'hp_oldEff');
  
  const [locationName, setLocationName] = useStickyState<string>('Hamburg', 'hp_locationName');
  const [lat, setLat] = useStickyState<number>(53.5511, 'hp_lat');
  const [lon, setLon] = useStickyState<number>(9.9937, 'hp_lon');
  const [searchResults, setSearchResults] = useState<LocationResult[]>([]);
  
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
  // Convert startDate string "YYYY-MM-DD" to a local date object at midnight
  const parseLocalYMD = (s: string) => {
    const parts = s.split('-');
    if (parts.length !== 3) return new Date('Invalid');
    return new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
  }

  const locStart = parseLocalYMD(startDate);
  const locEnd = parseLocalYMD(endDate);
  
  const isStartValid = !isNaN(locStart.getTime()) && locStart < todayStart;
  const isEndValid = !isNaN(locEnd.getTime()) && locEnd < todayStart && locStart <= locEnd;
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

  const selectLocation = (loc: LocationResult) => {
      setLat(loc.latitude);
      setLon(loc.longitude);
      setLocationName(`${loc.name} (${loc.admin1 || loc.country || ''})`);
      setSearchResults([]); 
      setError('');
  };

  const handleLocationSearch = async () => {
    setSearchResults([]);
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
        params: { name: locationName, count: 10, language: 'de', format: 'json' }
      });
      
      if (resp.data.results && resp.data.results.length > 0) {
        if (resp.data.results.length === 1) {
             selectLocation(resp.data.results[0]);
             alert(`Gefunden: ${resp.data.results[0].name}`);
        } else {
             setSearchResults(resp.data.results);
        }
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
      setParamA(0.71);
      setParamB(37);
      setCurveMode('params');
      setP1Out(20);
      setP1Flow(23);
      setP2Out(-25);
      setP2Flow(55);
      setArea(100.0);
      setUVal(0.5);
      setCalcMode('physics');
      setFuelType('gas');
      setFuelAmount(15000);
      setOldEff(0.85);
      setLocationName('Hamburg');
      setLat(53.5511);
      setLon(9.9937);
      setHeatStartD(1); setHeatStartM(10);
      setHeatEndD(30);  setHeatEndM(4);
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
      
      const checkInHeatingPeriod = (isoTime: string) => {
         // isoTime: "2023-01-01T00:00"
         const d = new Date(isoTime);
         const m = d.getMonth() + 1; // 1-12
         const day = d.getDate(); // 1-31
         
         // Convert to simple integer MM*100 + DD for comparison
         // e.g. Oct 1 -> 1001, Apr 30 -> 430
         const currentVal = m * 100 + day;
         const startVal = heatStartM * 100 + heatStartD;
         const endVal = heatEndM * 100 + heatEndD; // 0430
         
         if (startVal <= endVal) {
             // Normal range (e.g. Jan to Mar): Start <= Current <= End
             return currentVal >= startVal && currentVal <= endVal;
         } else {
             // Wrap around (e.g. Oct to Apr): Current >= Start OR Current <= End
             return currentVal >= startVal || currentVal <= endVal;
         }
      };

      if (calcMode === 'consumption') {
         let sumDegreeHours = 0;
         for (let i=0; i<temps.length; i++) {
             const tOut = temps[i];
             if (tOut !== null && tOut < tempInnen && checkInHeatingPeriod(resp.data.hourly.time[i])) {
                 sumDegreeHours += (tempInnen - tOut);
             }
         }
         
         if (sumDegreeHours === 0) {
           setError("Keine Heizstunden im Zeitraum (oder Prüfung auf Heizgrenze fehlgeschlagen).");
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
        // Check heating period
        const inHeatingPeriod = checkInHeatingPeriod(resp.data.hourly.time[i]);
        
        if (tOut < tempInnen && inHeatingPeriod) {
          const qLoad = k_load * (tempInnen - tOut);
          
          if (qLoad > maxHeatLoadW) {
             maxHeatLoadW = qLoad;
             maxHeatDate = resp.data.hourly.time[i];
          }

          // Vorlauf
          let tVorlauf = 0;
          if (curveMode === 'points') {
             // Linear: Flow(Out)
             // Avoid division by zero
             if (Math.abs(p2Out - p1Out) < 0.001) {
                 tVorlauf = (p1Flow + p2Flow) / 2; 
             } else {
                 const slope = (p2Flow - p1Flow) / (p2Out - p1Out);
                 tVorlauf = p1Flow + (tOut - p1Out) * slope;
             }
          } else {
             tVorlauf = - tOut * paramA + paramB;
          }
          
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
      <div className="input-group" style={{position: 'relative'}}>
        <label>Ort:</label>
        <div style={{display: 'flex', gap: '8px'}}>
          <input 
            type="text" 
            value={locationName} 
            onChange={(e) => setLocationName(e.target.value)} 
            onKeyDown={(e) => e.key === 'Enter' && handleLocationSearch()}
          />
          <button onClick={handleLocationSearch}>Suchen</button>
        </div>
        <small>Breite: {lat}, Länge: {lon}</small>

        {searchResults.length > 0 && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0, 
            right: 0,
            zIndex: 1000,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            maxHeight: '200px',
            overflowY: 'auto'
          }}>
            {searchResults.map(r => (
                <div 
                    key={r.id}
                    onClick={() => selectLocation(r)}
                    style={{
                        padding: '10px',
                        borderBottom: '1px solid #eee',
                        cursor: 'pointer'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'white'}
                >
                    <div style={{fontWeight: 'bold'}}>{r.name}</div>
                    <div style={{fontSize: '0.85em', color: '#666'}}>
                        {[r.admin1, r.country].filter(Boolean).join(', ')} ({r.latitude.toFixed(2)}, {r.longitude.toFixed(2)})
                    </div>
                </div>
            ))}
          </div>
        )}
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
           <small style={{display: 'block', marginTop: '4px', color: '#666'}}>
               Startdatum &lt; heute
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
            <small style={{display: 'block', marginTop: '4px', color: '#666'}}>
               Startdatum &lt;= Enddatum &lt; heute
            </small>
         </div>
      </div>
      
      <div className="input-group">
          <label>Heizperiode (Tag.Monat):</label>
          <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
              <span>Von:</span>
              <input type="number" min="1" max="31" style={{width:'60px'}} value={heatStartD} onChange={(e)=>setHeatStartD(parseInt(e.target.value))} />
              <span>.</span>
              <select value={heatStartM} onChange={(e)=>setHeatStartM(parseInt(e.target.value))}>
                  <option value={1}>Januar</option><option value={2}>Februar</option><option value={3}>März</option>
                  <option value={4}>April</option><option value={5}>Mai</option><option value={6}>Juni</option>
                  <option value={7}>Juli</option><option value={8}>August</option><option value={9}>September</option>
                  <option value={10}>Oktober</option><option value={11}>November</option><option value={12}>Dezember</option>
              </select>
              <span style={{marginLeft:'10px'}}>Bis:</span>
              <input type="number" min="1" max="31" style={{width:'60px'}} value={heatEndD} onChange={(e)=>setHeatEndD(parseInt(e.target.value))} />
              <span>.</span>
              <select value={heatEndM} onChange={(e)=>setHeatEndM(parseInt(e.target.value))}>
                  <option value={1}>Januar</option><option value={2}>Februar</option><option value={3}>März</option>
                  <option value={4}>April</option><option value={5}>Mai</option><option value={6}>Juni</option>
                  <option value={7}>Juli</option><option value={8}>August</option><option value={9}>September</option>
                  <option value={10}>Oktober</option><option value={11}>November</option><option value={12}>Dezember</option>
              </select>
          </div>
      </div>

      <div className="input-header">Heizkurve</div>
      <div className="input-group" style={{marginBottom: '10px'}}>
        <div style={{display: 'flex', gap: '10px'}}>
            <button 
                onClick={() => setCurveMode('params')}
                style={{
                    flex: 1,
                    padding: '8px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    backgroundColor: curveMode === 'params' ? '#007bff' : '#f9f9f9',
                    color: curveMode === 'params' ? 'white' : '#333',
                    cursor: 'pointer'
                }}
            >
                Parameter (a, b)
            </button>
             <button 
                onClick={() => setCurveMode('points')}
                style={{
                    flex: 1,
                    padding: '8px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    backgroundColor: curveMode === 'points' ? '#007bff' : '#f9f9f9',
                    color: curveMode === 'points' ? 'white' : '#333',
                    cursor: 'pointer'
                }}
            >
                2-Punkte (Fuß/End)
            </button>
        </div>
      </div>

      {curveMode === 'params' ? (
        <div className="grid-2">
           <div className="input-group">
             <label title="Neigung/Steigung der Kurve">Parameter a (Neigung):</label>
             <input type="number" step="0.1" value={paramA} onChange={(e) => setParamA(parseFloat(e.target.value))} />
           </div>
           <div className="input-group">
             <label title="Niveau/Verschiebung">Parameter b (Niveau) °C:</label>
             <input type="number" value={paramB} onChange={(e) => setParamB(parseFloat(e.target.value))} />
           </div>
           <small style={{gridColumn: '1 / -1', color:'#666', marginTop:'-10px', marginBottom:'10px'}}>
             Formel: T_vorlauf = - T_aussen * a + b, wobei b die Vorlauftemperatur bei 0°C Außen darstellt.
           </small>
        </div>
      ) : (
        <div className="grid-2">
           <div className="input-group">
             <label>Punkt 1 (Fußpunkt):</label>
             <div style={{display:'flex', gap:'10px', alignItems:'center'}}>
                <div style={{flex:1}}>
                  <small style={{display:'block', marginBottom:'2px'}}>Außen (T_aussen)</small>
                  <input type="number" value={p1Out} onChange={(e) => setP1Out(parseFloat(e.target.value))} />
                </div>
                <div style={{flex:1}}>
                  <small style={{display:'block', marginBottom:'2px'}}>Vorlauf (T_vl)</small>
                  <input type="number" value={p1Flow} onChange={(e) => setP1Flow(parseFloat(e.target.value))} />
                </div>
             </div>
           </div>
           <div className="input-group">
             <label>Punkt 2 (Endpunkt):</label>
             <div style={{display:'flex', gap:'10px', alignItems:'center'}}>
                <div style={{flex:1}}>
                   <small style={{display:'block', marginBottom:'2px'}}>Außen (T_aussen)</small>
                   <input type="number" value={p2Out} onChange={(e) => setP2Out(parseFloat(e.target.value))} />
                </div>
                <div style={{flex:1}}>
                   <small style={{display:'block', marginBottom:'2px'}}>Vorlauf (T_vl)</small>
                   <input type="number" value={p2Flow} onChange={(e) => setP2Flow(parseFloat(e.target.value))} />
                </div>
             </div>
           </div>
        </div>
      )}

      <div className="input-group">
        <label>Berechnungsmodus:</label>
        <div style={{display: 'flex', gap: '10px'}}>
            <button 
                onClick={() => setCalcMode('physics')}
                style={{
                    flex: 1,
                    padding: '8px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    backgroundColor: calcMode === 'physics' ? '#007bff' : '#f9f9f9',
                    color: calcMode === 'physics' ? 'white' : '#333',
                    cursor: 'pointer'
                }}
            >
                Bauphysik (U * A)
            </button>
            <button 
                onClick={() => setCalcMode('consumption')}
                style={{
                    flex: 1,
                    padding: '8px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    backgroundColor: calcMode === 'consumption' ? '#007bff' : '#f9f9f9',
                    color: calcMode === 'consumption' ? 'white' : '#333',
                    cursor: 'pointer'
                }}
            >
                Verbrauch (Gas/Öl)
            </button>
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
        v1.13 (16.01.2025)
        <br />
        Daten werden nur lokal zu Berechnungszwecken gespeichert.
      </div>
    </div>
  );
};

export default HeatPumpCalculator;
