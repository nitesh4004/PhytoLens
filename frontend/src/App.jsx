import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { 
  Satellite, 
  Activity, 
  Layers, 
  Download, 
  RefreshCw, 
  Sliders, 
  Calendar,
  AlertTriangle,
  FileCheck,
  CheckCircle2,
  Clock,
  Compass,
  Upload,
  Eye,
  PenTool,
  X,
  MapPin,
  Cpu
} from 'lucide-react';

const get_color_palette = (name) => {
  const palettes = {
    "Red-Yellow-Green (Vegetation)": ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'],
    "Blue-White-Green (Water/Veg)": ['#0000ff', '#ffffff', '#008000'],
    "Blue-Yellow-Red (Thermal)": ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'],
    "Viridis (Sequential)": ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    "Magma (Sequential)": ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fcfdbf'],
    "Inferno (Sequential)": ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746'],
    "Plasma (Sequential)": ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
    "Turbo (Rainbow Enhanced)": ['#30123b', '#466be3', '#28bbec', '#32f197', '#a2fc3c', '#f2f221', '#fc8961', '#cf2547', '#7a0403'],
    "Ocean (Water Depth)": ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'],
    "Terrain (Elevation)": ['#006400', '#32CD32', '#FFFF00', '#DAA520', '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#F4A460', '#DEB887', '#D3D3D3', '#FFFFFF'],
    "Greyscale": ['#000000', '#FFFFFF']
  };
  return palettes[name] || palettes["Red-Yellow-Green (Vegetation)"];
};

const API_BASE = "http://127.0.0.1:8000";

// --- CLIENT-SIDE PARSERS FOR KML AND GEOJSON ---
const parseKmlText = (text) => {
  try {
    const coordRegex = /<coordinates>([\s\S]*?)<\/coordinates>/i;
    const match = coordRegex.exec(text);
    if (match && match[1]) {
      const coordsRaw = match[1].trim().split(/\s+/);
      const lons = [];
      const lats = [];
      const coordinates = [];
      coordsRaw.forEach(str => {
        const parts = str.split(',');
        if (parts.length >= 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          lons.push(lon);
          lats.push(lat);
          coordinates.push([lon, lat]);
        }
      });
      if (lons.length > 0) {
        // Form a closed loop for Polygon if start and end don't match
        if (coordinates.length > 0 && 
            (coordinates[0][0] !== coordinates[coordinates.length - 1][0] || 
             coordinates[0][1] !== coordinates[coordinates.length - 1][1])) {
          coordinates.push(coordinates[0]);
        }
        
        const geojson = {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [coordinates]
          },
          properties: {}
        };

        return {
          bounds: {
            minLon: Math.min(...lons),
            maxLon: Math.max(...lons),
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats)
          },
          geojson
        };
      }
    }
  } catch (e) {
    console.error("KML parse error:", e);
  }
  return null;
};

const parseGeoJsonText = (text) => {
  try {
    const geojson = JSON.parse(text);
    let coords = [];
    
    const extractCoords = (geom) => {
      if (!geom) return;
      if (geom.type === "Point") {
        coords.push(geom.coordinates);
      } else if (geom.type === "LineString" || geom.type === "MultiPoint") {
        coords.push(...geom.coordinates);
      } else if (geom.type === "Polygon" || geom.type === "MultiLineString") {
        geom.coordinates.forEach(ring => coords.push(...ring));
      } else if (geom.type === "MultiPolygon") {
        geom.coordinates.forEach(poly => poly.forEach(ring => coords.push(...ring)));
      } else if (geom.type === "GeometryCollection") {
        geom.geometries.forEach(g => extractCoords(g));
      }
    };
    
    if (geojson.type === "FeatureCollection") {
      geojson.features.forEach(f => extractCoords(f.geometry));
    } else if (geojson.type === "Feature") {
      extractCoords(geojson.geometry);
    } else if (geojson.geometry) {
      extractCoords(geojson.geometry);
    } else if (geojson.coordinates) {
      extractCoords(geojson);
    }
    
    if (coords.length > 0) {
      const lons = coords.map(c => c[0]).filter(v => !isNaN(v));
      const lats = coords.map(c => c[1]).filter(v => !isNaN(v));
      if (lons.length > 0) {
        return {
          bounds: {
            minLon: Math.min(...lons),
            maxLon: Math.max(...lons),
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats)
          },
          geojson
        };
      }
    }
  } catch (e) {
    console.error("GeoJSON parse error:", e);
  }
  return null;
};

// Standard Leaflet Marker icon fix
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// --- INTERACTIVE EXCEL-STYLE TIME SERIES CHART ---
function TimeSeriesChart({ data, indexName, onViewScene, activeSceneId }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(300);
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Toggles for Mean, Min, Max lines
  const [showMean, setShowMean] = useState(true);
  const [showMin, setShowMin] = useState(false);
  const [showMax, setShowMax] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const handleResize = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.clientWidth || 300);
      }
    };
    handleResize();
    const observer = new ResizeObserver((entries) => {
      handleResize();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  if (!data || data.length === 0) return null;

  // Chart dimensions
  const height = 220;
  const paddingLeft = 45;
  const paddingRight = 15;
  const paddingTop = 40; // More room for title and legends
  const paddingBottom = 35;

  const chartWidth = Math.max(50, width - paddingLeft - paddingRight);
  const chartHeight = height - paddingTop - paddingBottom;

  // Extract min/max values based on visible series (Excel style)
  const activeYValues = [];
  data.forEach(d => {
    if (showMean && d.mean !== undefined) activeYValues.push(d.mean);
    if (showMin && d.min !== undefined) activeYValues.push(d.min);
    if (showMax && d.max !== undefined) activeYValues.push(d.max);
  });
  
  if (activeYValues.length === 0) {
    data.forEach(d => {
      if (d.mean !== undefined) activeYValues.push(d.mean);
      if (d.min !== undefined) activeYValues.push(d.min);
      if (d.max !== undefined) activeYValues.push(d.max);
    });
  }

  let minY = Math.min(...activeYValues);
  let maxY = Math.max(...activeYValues);
  
  // Padding to Y limits
  const yRange = maxY - minY || 0.1;
  minY = minY - yRange * 0.1;
  maxY = maxY + yRange * 0.1;

  // Coordinate scaling helpers
  const getX = (index) => {
    if (data.length <= 1) return paddingLeft + chartWidth / 2;
    return paddingLeft + (index / (data.length - 1)) * chartWidth;
  };

  const getY = (val) => {
    return paddingTop + chartHeight - ((val - minY) / (maxY - minY)) * chartHeight;
  };

  // Build Excel series path strings
  const buildPath = (key) => {
    if (data.length === 0) return "";
    let pathStr = `M ${getX(0)} ${getY(data[0][key])}`;
    for (let i = 1; i < data.length; i++) {
      pathStr += ` L ${getX(i)} ${getY(data[i][key])}`;
    }
    return pathStr;
  };

  const meanPath = buildPath("mean");
  const minPath = buildPath("min");
  const maxPath = buildPath("max");

  // Y Axis ticks (5 values, clean Excel style grid lines)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    yTicks.push(minY + (i / 4) * (maxY - minY));
  }

  // X Axis ticks (Excel categories)
  const xTicks = [];
  if (data.length > 0) {
    xTicks.push({ index: 0, date: data[0].date });
    if (data.length > 2) {
      const mid = Math.floor(data.length / 2);
      xTicks.push({ index: mid, date: data[mid].date });
    }
    if (data.length > 1) {
      xTicks.push({ index: data.length - 1, date: data[data.length - 1].date });
    }
  }

  // Handle CSV Export
  const handleExportCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Date,Scene_ID,Mean,Min,Max,Std_Dev,Cloud_Cover\n";
    data.forEach(d => {
      csvContent += `${d.date},${d.scene_id},${d.mean.toFixed(4)},${d.min.toFixed(4)},${d.max.toFixed(4)},${d.std.toFixed(4)},${d.cloud_cover.toFixed(1)}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `PhytoLens_TimeSeries_${indexName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Handle Mouse Hover on Canvas (Scrubber)
  const handleMouseMove = (e) => {
    if (!containerRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    
    // Calculate closest index based on X
    const pct = (mouseX - paddingLeft) / chartWidth;
    let idx = Math.round(pct * (data.length - 1));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    
    const point = data[idx];
    setHoveredPoint({ ...point, idx });

    // Determine tooltip position
    const cx = getX(idx);
    // Tooltip snaps to the Mean value or whichever line is visible
    let cy = getY(point.mean);
    if (!showMean && showMax) cy = getY(point.max);
    else if (!showMean && !showMax && showMin) cy = getY(point.min);

    setTooltipPos({ x: cx, y: cy });
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  // Check if active overlay scene is on this date
  const isSceneActive = (sceneId) => {
    return activeSceneId && activeSceneId === sceneId;
  };

  return (
    <div className="excel-chart-card" ref={containerRef}>
      {/* Title */}
      <div className="excel-chart-title text-center">
        {indexName} Seasonal Trend
      </div>

      {/* Legend & Multi-series Checkboxes */}
      <div className="excel-legend-container">
        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMean} 
            onChange={(e) => setShowMean(e.target.checked)} 
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#4472c4' }}></span>
          <span className="excel-legend-text">Mean {indexName}</span>
        </label>
        
        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMax} 
            onChange={(e) => setShowMax(e.target.checked)}
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#ed7d31' }}></span>
          <span className="excel-legend-text">Max {indexName}</span>
        </label>

        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMin} 
            onChange={(e) => setShowMin(e.target.checked)}
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#a5a5a5' }}></span>
          <span className="excel-legend-text">Min {indexName}</span>
        </label>
      </div>

      {/* SVG Canvas */}
      <div className="relative mt-2">
        <svg 
          width="100%" 
          height={height} 
          viewBox={`0 0 ${width} ${height}`} 
          className="trend-svg"
          style={{ overflow: 'visible', cursor: 'crosshair' }}
        >
          {/* Horizontal Gridlines */}
          {yTicks.map((val, idx) => (
            <line 
              key={idx} 
              x1={paddingLeft} 
              y1={getY(val)} 
              x2={width - paddingRight} 
              y2={getY(val)} 
              stroke="#e2e2e2" 
              strokeWidth="0.75"
            />
          ))}

          {/* X and Y Axes Lines */}
          <line 
            x1={paddingLeft} 
            y1={height - paddingBottom} 
            x2={width - paddingRight} 
            y2={height - paddingBottom} 
            stroke="#7f7f7f" 
            strokeWidth="1.2"
          />
          <line 
            x1={paddingLeft} 
            y1={paddingTop} 
            x2={paddingLeft} 
            y2={height - paddingBottom} 
            stroke="#7f7f7f" 
            strokeWidth="1.2"
          />

          {/* Y Axis Labels */}
          {yTicks.map((val, idx) => (
            <text 
              key={idx} 
              x={paddingLeft - 6} 
              y={getY(val) + 3.5} 
              textAnchor="end" 
              className="excel-axis-text"
            >
              {val.toFixed(2)}
            </text>
          ))}

          {/* X Axis Labels */}
          {xTicks.map((t, idx) => (
            <g key={idx}>
              {/* Tick Mark */}
              <line 
                x1={getX(t.index)} 
                y1={height - paddingBottom} 
                x2={getX(t.index)} 
                y2={height - paddingBottom + 4} 
                stroke="#7f7f7f" 
                strokeWidth="1"
              />
              <text 
                x={getX(t.index)} 
                y={height - paddingBottom + 15} 
                textAnchor="middle" 
                className="excel-axis-text"
              >
                {t.date}
              </text>
            </g>
          ))}

          {/* Active Overlay Vertical Line */}
          {data.map((d, idx) => {
            if (isSceneActive(d.scene_id)) {
              return (
                <line
                  key={`active-line-${idx}`}
                  x1={getX(idx)}
                  y1={paddingTop}
                  x2={getX(idx)}
                  y2={height - paddingBottom}
                  stroke="#4472c4"
                  strokeWidth="1.2"
                  strokeDasharray="2, 2"
                  style={{ pointerEvents: 'none' }}
                />
              );
            }
            return null;
          })}

          {/* Min Line (Grey) */}
          {showMin && minPath && (
            <path 
              d={minPath} 
              fill="none" 
              stroke="#a5a5a5" 
              strokeWidth="1.8" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Max Line (Orange) */}
          {showMax && maxPath && (
            <path 
              d={maxPath} 
              fill="none" 
              stroke="#ed7d31" 
              strokeWidth="1.8" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Mean Line (Blue) */}
          {showMean && meanPath && (
            <path 
              d={meanPath} 
              fill="none" 
              stroke="#4472c4" 
              strokeWidth="2" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Snapping Vertical Crosshair Guide */}
          {hoveredPoint && (
            <line
              x1={getX(hoveredPoint.idx)}
              y1={paddingTop}
              x2={getX(hoveredPoint.idx)}
              y2={height - paddingBottom}
              stroke="#7f7f7f"
              strokeWidth="1"
              strokeDasharray="3, 3"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Markers */}
          {data.map((d, idx) => {
            const cx = getX(idx);
            const isHovered = hoveredPoint && hoveredPoint.idx === idx;
            const isCurrentActive = isSceneActive(d.scene_id);

            return (
              <g key={idx}>
                {/* Min Markers */}
                {showMin && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.min)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#a5a5a5" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Max Markers */}
                {showMax && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.max)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#ed7d31" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Mean Markers */}
                {showMean && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.mean)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#4472c4" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Active Overlay pulsing ring */}
                {isCurrentActive && showMean && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.mean)} 
                    r="8" 
                    fill="none" 
                    stroke="#4472c4" 
                    strokeWidth="1.5" 
                    strokeDasharray="2, 2"
                    className="excel-pulse-ring"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              </g>
            );
          })}

          {/* Mouse Scrubber Overlay Capture Box */}
          <rect
            x={paddingLeft}
            y={paddingTop}
            width={chartWidth}
            height={chartHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{ cursor: 'crosshair' }}
          />
        </svg>

        {/* Excel Tooltip */}
        {hoveredPoint && (
          <div 
            className="excel-tooltip"
            style={{ 
              left: tooltipPos.x > width * 0.5 ? `${tooltipPos.x - 170}px` : `${tooltipPos.x + 15}px`,
              top: `${tooltipPos.y - 15}px`
            }}
          >
            <div className="excel-tooltip-date">{hoveredPoint.date}</div>
            <div className="excel-tooltip-grid">
              {showMean && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#4472c4', fontWeight: 'bold' }}>Mean:</span>
                  <span className="font-bold">{hoveredPoint.mean.toFixed(4)}</span>
                </div>
              )}
              {showMax && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#ed7d31', fontWeight: 'bold' }}>Max:</span>
                  <span className="font-bold">{hoveredPoint.max.toFixed(4)}</span>
                </div>
              )}
              {showMin && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#a5a5a5', fontWeight: 'bold' }}>Min:</span>
                  <span className="font-bold">{hoveredPoint.min.toFixed(4)}</span>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t border-slate-200 mt-1 pt-1 text-[10px] text-slate-500">
                <span>Cloud:</span>
                <span>{hoveredPoint.cloud_cover.toFixed(1)}%</span>
              </div>
              {isSceneActive(hoveredPoint.scene_id) && (
                <div className="text-[9px] font-bold mt-1 text-center text-blue-600 uppercase">
                  ★ Active Map Overlay
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* CSV Export & Actions bar */}
      <div className="flex justify-between items-center mt-3 pt-2 border-t border-slate-200">
        <span className="text-[10px] text-slate-500 font-bold">
          Total: {data.length} Dates
        </span>
        <button 
          onClick={handleExportCSV} 
          className="excel-btn"
        >
          Export CSV
        </button>
      </div>

      {/* Mini data table */}
      <div className="mt-3 overflow-y-auto max-h-[140px] border border-slate-200 rounded">
        <table className="excel-data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Mean</th>
              <th>Min/Max Range</th>
              <th>Cloud %</th>
              <th style={{ textAlign: 'center' }}>Map</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d, idx) => {
              // conditional formatting color code for cloud cover (Excel style green to red)
              let cloudStyle = { color: '#385723', fontWeight: 'bold' }; // Deep Excel Green
              if (d.cloud_cover > 15) cloudStyle = { color: '#c00000', fontWeight: 'bold' }; // Deep Excel Red
              else if (d.cloud_cover > 5) cloudStyle = { color: '#c65911', fontWeight: 'bold' }; // Excel Amber

              const isCurrentHovered = hoveredPoint && hoveredPoint.idx === idx;
              const isActiveScene = isSceneActive(d.scene_id);

              return (
                <tr 
                  key={idx}
                  style={{ 
                    backgroundColor: isActiveScene 
                      ? '#e6f0fa' 
                      : (isCurrentHovered ? '#f1f5f9' : 'transparent'),
                    transition: 'background-color 0.15s ease'
                  }}
                  onMouseEnter={() => setHoveredPoint({ ...d, idx })}
                  onMouseLeave={() => setHoveredPoint(null)}
                >
                  <td className="text-[10px] font-medium text-slate-600">{d.date}</td>
                  <td className="text-[10px] font-bold text-blue-700">{d.mean.toFixed(2)}</td>
                  <td className="text-[10px] text-slate-500">{d.min.toFixed(0)} / {d.max.toFixed(0)}</td>
                  <td className="text-[10px]" style={cloudStyle}>{d.cloud_cover.toFixed(0)}%</td>
                  <td className="text-center">
                    <button 
                      onClick={() => handleSceneToggle(d.scene_id)}
                      className={`text-[10px] px-2 py-0.5 rounded border ${isActiveScene ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'}`}
                    >
                      {isActiveScene ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  // Navigation tabs
  const [activeTab, setActiveTab] = useState("Spectral Monitor");

  // Region of Interest (ROI) State
  const [minLon, setMinLon] = useState(78.900000);
  const [minLat, setMinLat] = useState(20.500000);
  const [maxLon, setMaxLon] = useState(79.050000);
  const [maxLat, setMaxLat] = useState(20.650000);
  const [roiMethod, setRoiMethod] = useState("file"); // "file" | "draw"
  const [pointLat, setPointLat] = useState(20.575018);
  const [pointLon, setPointLon] = useState(78.975000);
  const [pointRadius, setPointRadius] = useState(5000); // meters
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [uploadedGeoJson, setUploadedGeoJson] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawVertices, setDrawVertices] = useState([]);
  const drawVerticesRef = useRef([]);
  const drawLineRef = useRef(null);
  const firstVertexMarkerRef = useRef(null); // Ref to closing circle marker

  // Satellite search state
  const [platform, setPlatform] = useState("Sentinel-2 (Optical)");
  const [startDate, setStartDate] = useState("2024-01-01");
  const [endDate, setEndDate] = useState("2024-02-15");
  const [cloudCover, setCloudCover] = useState(12);
  const [orbit, setOrbit] = useState("BOTH");

  // STAC search items
  const [scenes, setScenes] = useState([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSceneMeta, setSelectedSceneMeta] = useState(null);
  const [showRoiPopup, setShowRoiPopup] = useState(false);
  const [showScenePopup, setShowScenePopup] = useState(false);
  const [showModePopup, setShowModePopup] = useState(false);
  const [showSettingsPopup, setShowSettingsPopup] = useState(false);

  // --- Spectral Monitor State ---
  const [spectralIndex, setSpectralIndex] = useState("NDVI");
  const [customFormula, setCustomFormula] = useState("(B8 - B4) / (B8 + B4)");
  const [colorPalette, setColorPalette] = useState("Red-Yellow-Green (Vegetation)");
  const [visMin, setVisMin] = useState("0.009");
  const [visMax, setVisMax] = useState("0.657");
  const [spectralResult, setSpectralResult] = useState(null);

  // Time Series Analysis States
  const [analysisMode, setAnalysisMode] = useState("single"); // "single" | "timeseries" | "lulc"
  const [timeSeriesResult, setTimeSeriesResult] = useState(null);
  const [maxScenes, setMaxScenes] = useState(15);
  const [timeSeriesLoading, setTimeSeriesLoading] = useState(false);

  // LULC Mapping States
  const [lulcDataset, setLulcDataset] = useState("esa-worldcover");
  const [lulcYear, setLulcYear] = useState(2021);
  const [lulcResult, setLulcResult] = useState(null);
  const [lulcLoading, setLulcLoading] = useState(false);

  // AEF AI Clustering States
  const [aefYear, setAefYear] = useState(2024);
  const [aefClusters, setAefClusters] = useState(5);
  const [aefResult, setAefResult] = useState(null);
  const [aefLoading, setAefLoading] = useState(false);
  const [customClusterNames, setCustomClusterNames] = useState({});

  // AEF AI Similarity States
  const [queryGeometry, setQueryGeometry] = useState(null);
  const [queryFileName, setQueryFileName] = useState("");
  const [drawingTarget, setDrawingTarget] = useState("roi"); // "roi" | "query"
  const [aefSimMode, setAefSimMode] = useState("centered"); // "centered" | "dotproduct"
  const [aefThreshold, setAefThreshold] = useState(0.5);
  const [similarityResult, setSimilarityResult] = useState(null);
  const [similarityLoading, setSimilarityLoading] = useState(false);

  // Dynamic Overlay Resize states
  const [resultsWidth, setResultsWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = (mouseDownEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const newWidth = window.innerWidth - e.clientX;
      // Constrain sidebar panel width between 300px and 600px
      if (newWidth >= 300 && newWidth <= 600) {
        setResultsWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);


  // App UI states
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [toast, setToast] = useState(null);
  const [baseMap, setBaseMap] = useState("satellite");
  const [systemTime, setSystemTime] = useState("12:45:15 UTC");
  const [hoverCoords, setHoverCoords] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchCoords, setSearchCoords] = useState("");
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [resultsPanelOpen, setResultsPanelOpen] = useState(false);

  // Map references
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const roiLayerRef = useRef(null);
  const imageOverlayRef = useRef(null);
  const baseTilesRef = useRef(null);
  const geoJsonLayerRef = useRef(null);
  const queryLayerRef = useRef(null);

  // Sync drawVertices state with ref
  useEffect(() => {
    drawVerticesRef.current = drawVertices;
  }, [drawVertices]);

  // Time stamp ticker
  useEffect(() => {
    const updateTime = () => {
      const d = new Date();
      setSystemTime(
        d.toLocaleTimeString("en-US", { hour12: false }) + " UTC"
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Toast notification alert helper
  const showToast = (message, isError = false) => {
    setToast({ message, isError });
    setTimeout(() => setToast(null), 4000);
  };

  const updateDrawingLayer = (vertices, isPreview = false) => {
    const map = mapRef.current;
    if (!map) return;

    if (drawLineRef.current) {
      map.removeLayer(drawLineRef.current);
      drawLineRef.current = null;
    }

    const drawColor = drawingTarget === "query" ? '#f59e0b' : '#dc2626';
    const drawFill = drawingTarget === "query" ? 'rgba(245,158,11,0.1)' : 'rgba(220,38,38,0.1)';

    if (vertices.length > 0) {
      if (vertices.length >= 3 && !isPreview) {
        drawLineRef.current = L.polygon(vertices, {
          color: drawColor,
          weight: 2.5,
          fillColor: drawFill,
          dashArray: null
        }).addTo(map);
      } else {
        drawLineRef.current = L.polyline(vertices, {
          color: drawColor,
          weight: 2,
          dashArray: '5, 5'
        }).addTo(map);
      }
    }

    const actualVertices = isPreview ? vertices.slice(0, -1) : vertices;

    if (actualVertices.length >= 3) {
      if (!firstVertexMarkerRef.current) {
        firstVertexMarkerRef.current = L.circleMarker(actualVertices[0], {
          radius: 8,
          color: drawColor,
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 3,
          interactive: true
        })
        .addTo(map)
        .bindTooltip("Click to close shape", { permanent: false, direction: 'top' });

        firstVertexMarkerRef.current.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          finishDrawingPolygon();
        });
      } else {
        firstVertexMarkerRef.current.setLatLng(actualVertices[0]);
      }
    } else {
      if (firstVertexMarkerRef.current) {
        map.removeLayer(firstVertexMarkerRef.current);
        firstVertexMarkerRef.current = null;
      }
    }
  };

  const finishDrawingPolygon = () => {
    const vertices = drawVerticesRef.current;
    if (vertices.length < 3) {
      showToast("Please click at least 3 points to define a polygon.", true);
      return;
    }

    // Create closed coordinates loop: [lon, lat] for GeoJSON
    const coordinates = vertices.map(v => [v[1], v[0]]);
    coordinates.push(coordinates[0]); // close loop

    const geojson = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coordinates]
      },
      properties: {}
    };

    if (drawingTarget === "query") {
      let newGeojson;
      if (queryGeometry && queryGeometry.type === "FeatureCollection") {
        newGeojson = {
          ...queryGeometry,
          features: [...queryGeometry.features, geojson]
        };
      } else if (queryGeometry) {
        const existingFeature = queryGeometry.type === "Feature" ? queryGeometry : {
          type: "Feature",
          geometry: queryGeometry,
          properties: {}
        };
        newGeojson = {
          type: "FeatureCollection",
          features: [existingFeature, geojson]
        };
      } else {
        newGeojson = geojson;
      }
      setQueryGeometry(newGeojson);
      const count = newGeojson.type === "FeatureCollection" ? newGeojson.features.length : 1;
      setQueryFileName(`${count} Drawn Query Feature${count > 1 ? 's' : ''}`);
      stopDrawMode();
      showToast("Query feature drawn successfully");
      return;
    }

    // Compute bounding box
    const lons = vertices.map(v => v[1]);
    const lats = vertices.map(v => v[0]);
    const minL = Math.min(...lons);
    const maxL = Math.max(...lons);
    const minT = Math.min(...lats);
    const maxT = Math.max(...lats);

    setMinLon(parseFloat(minL.toFixed(6)));
    setMaxLon(parseFloat(maxL.toFixed(6)));
    setMinLat(parseFloat(minT.toFixed(6)));
    setMaxLat(parseFloat(maxT.toFixed(6)));

    setPointLat(parseFloat(((minT + maxT) / 2).toFixed(6)));
    setPointLon(parseFloat(((minL + maxL) / 2).toFixed(6)));

    setUploadedGeoJson(geojson);
    setUploadedFileName("Drawn Polygon ROI");
    setRoiMethod("file");

    stopDrawMode();
    showToast("Custom polygon drawn successfully");
  };

  // Enable/disable draw mode on the map
  const startDrawMode = (target = "roi") => {
    setIsDrawing(true);
    setDrawingTarget(target);
    if (target === "roi") {
      setRoiMethod("draw");
      setUploadedGeoJson(null);
      setUploadedFileName("");
    }
    setDrawVertices([]);
    if (mapRef.current) {
      mapRef.current.getContainer().style.cursor = 'crosshair';
      mapRef.current.doubleClickZoom.disable();
    }
    showToast(`Click on map to draw ${target === "roi" ? "ROI" : "Query Feature"} vertices. Click the first point to close.`);
  };

  const stopDrawMode = () => {
    setIsDrawing(false);
    setDrawVertices([]);
    if (mapRef.current) {
      mapRef.current.getContainer().style.cursor = '';
      mapRef.current.doubleClickZoom.enable();
    }
    if (drawLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(drawLineRef.current);
      drawLineRef.current = null;
    }
    if (firstVertexMarkerRef.current && mapRef.current) {
      mapRef.current.removeLayer(firstVertexMarkerRef.current);
      firstVertexMarkerRef.current = null;
    }
  };

  // Map draw interaction handlers
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    const onClick = (e) => {
      if (!isDrawing) return;

      // Close polygon if clicking near first vertex
      if (drawVerticesRef.current.length >= 3) {
        const firstLatLng = L.latLng(drawVerticesRef.current[0]);
        const p1 = map.latLngToLayerPoint(firstLatLng);
        const p2 = map.latLngToLayerPoint(e.latlng);
        const pixelDistance = p1.distanceTo(p2);
        if (pixelDistance < 15) {
          finishDrawingPolygon();
          return;
        }
      }

      const newVertex = [e.latlng.lat, e.latlng.lng];
      const next = [...drawVerticesRef.current, newVertex];
      setDrawVertices(next);
      updateDrawingLayer(next);
    };

    const onMouseMove = (e) => {
      if (!isDrawing || drawVerticesRef.current.length === 0) return;
      const currentMousePos = [e.latlng.lat, e.latlng.lng];
      updateDrawingLayer([...drawVerticesRef.current, currentMousePos], true);
    };

    const onDblClick = (e) => {
      if (!isDrawing) return;
      e.originalEvent.stopPropagation();
      finishDrawingPolygon();
    };

    map.on('click', onClick);
    map.on('mousemove', onMouseMove);
    map.on('dblclick', onDblClick);

    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMouseMove);
      map.off('dblclick', onDblClick);
    };
  }, [isDrawing, drawingTarget]);

  // Leaflet Map Setup
  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([pointLat, pointLon], 11);
      
      mapRef.current = map;

      // Map Tile Layers
      const satelliteTiles = L.tileLayer(
        'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        { maxZoom: 20, attribution: 'Google' }
      );
      const streetTiles = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19 }
      );

      baseTilesRef.current = { satellite: satelliteTiles, streets: streetTiles };
      satelliteTiles.addTo(map);

      // Track coordinates under mouse cursor
      map.on('mousemove', (e) => {
        setHoverCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
    }
  }, []);

  // Update base tiles
  useEffect(() => {
    if (mapRef.current && baseTilesRef.current) {
      const map = mapRef.current;
      const { satellite, streets } = baseTilesRef.current;

      if (baseMap === "satellite") {
        map.removeLayer(streets);
        satellite.addTo(map);
      } else {
        map.removeLayer(satellite);
        streets.addTo(map);
      }
    }
  }, [baseMap]);

  // Sync ROI layer (rectangle or custom polygon) on change
  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;

      // Remove existing layers
      if (roiLayerRef.current) {
        map.removeLayer(roiLayerRef.current);
        roiLayerRef.current = null;
      }
      if (geoJsonLayerRef.current) {
        map.removeLayer(geoJsonLayerRef.current);
        geoJsonLayerRef.current = null;
      }

      // Render new layer based on method
      if (roiMethod === "file" && uploadedGeoJson) {
        const layer = L.geoJSON(uploadedGeoJson, {
          style: {
            color: "#dc2626",
            weight: 2.5,
            fillColor: "rgba(220, 38, 38, 0.06)",
            dashArray: null
          }
        }).addTo(map);
        geoJsonLayerRef.current = layer;
        map.fitBounds(layer.getBounds(), { padding: [50, 50] });
      }
    }
  }, [minLon, minLat, maxLon, maxLat, roiMethod, uploadedGeoJson]);

  // Sync Query Geometry layer on change
  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;
      if (queryLayerRef.current) {
        map.removeLayer(queryLayerRef.current);
        queryLayerRef.current = null;
      }
      if (queryGeometry) {
        const layer = L.geoJSON(queryGeometry, {
          style: {
            color: "#f59e0b", // Amber/Orange
            weight: 2.5,
            fillColor: "rgba(245, 158, 11, 0.15)",
            dashArray: null
          }
        }).addTo(map);
        queryLayerRef.current = layer;
      }
    }
  }, [queryGeometry]);

  // Sync raster overlay opacity when slider changes
  useEffect(() => {
    if (imageOverlayRef.current) {
      imageOverlayRef.current.setOpacity(overlayOpacity);
    }
  }, [overlayOpacity]);

  const handleLocateClient = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        if (mapRef.current) {
          mapRef.current.setView([latitude, longitude], 13);
          setPointLat(parseFloat(latitude.toFixed(6)));
          setPointLon(parseFloat(longitude.toFixed(6)));
          showToast("GPS position acquired and synced.");
        }
      }, (err) => {
        showToast("GPS location failed or permission denied.", true);
      });
    } else {
      showToast("Geolocation not supported by browser.", true);
    }
  };

  const toggleFullscreen = () => {
    const mapContainer = mapContainerRef.current?.parentElement;
    if (!mapContainer) return;
    if (!document.fullscreenElement) {
      mapContainer.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (!searchCoords) return;
    const parts = searchCoords.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const [lat, lon] = parts;
      if (mapRef.current) {
        mapRef.current.setView([lat, lon], 12);
        showToast(`Centered map at Lat: ${lat}, Lon: ${lon}`);
      }
    } else {
      showToast("Format must be 'lat, lon'", true);
    }
  };

  // Center ROI on map center
  const setRoiToMapCenter = () => {
    if (mapRef.current) {
      const center = mapRef.current.getCenter();
      setPointLat(parseFloat(center.lat.toFixed(6)));
      setPointLon(parseFloat(center.lng.toFixed(6)));
      setRoiMethod("point");
      showToast("ROI locked to current viewport center");
    }
  };

  // KML/GeoJSON upload handler
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      let parseResult = null;

      if (file.name.endsWith(".kml")) {
        parseResult = parseKmlText(text);
      } else if (file.name.endsWith(".geojson") || file.name.endsWith(".json")) {
        parseResult = parseGeoJsonText(text);
      }

      if (parseResult && parseResult.bounds) {
        const { minLon, minLat, maxLon, maxLat } = parseResult.bounds;
        setMinLon(parseFloat(minLon.toFixed(6)));
        setMaxLon(parseFloat(maxLon.toFixed(6)));
        setMinLat(parseFloat(minLat.toFixed(6)));
        setMaxLat(parseFloat(maxLat.toFixed(6)));
        
        // Pointers representation
        setPointLat(parseFloat(((minLat + maxLat) / 2).toFixed(6)));
        setPointLon(parseFloat(((minLon + maxLon) / 2).toFixed(6)));
        
        setUploadedGeoJson(parseResult.geojson);
        showToast(`Boundary ROI loaded from ${file.name}`);
      } else {
        showToast("No valid polygon coordinate vectors found in file.", true);
      }
    };
    reader.readAsText(file);
  };

  // Query feature KML/GeoJSON upload handler (AI Similarity search).
  // Unlike the ROI upload this does NOT touch the bounding box — the query
  // feature is a small reference area that lives inside the Target ROI.
  const handleQueryFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      let parseResult = null;

      if (file.name.endsWith(".kml")) {
        parseResult = parseKmlText(text);
      } else if (file.name.endsWith(".geojson") || file.name.endsWith(".json")) {
        parseResult = parseGeoJsonText(text);
      }

      if (parseResult && parseResult.geojson) {
        setQueryGeometry(parseResult.geojson);
        setQueryFileName(file.name);
        showToast(`Query feature loaded from ${file.name}`);
      } else {
        showToast("No valid polygon coordinate vectors found in file.", true);
      }
    };
    reader.readAsText(file);
    // Reset so re-selecting the same file fires onChange again
    e.target.value = "";
  };

  // Sync selected scene metadata for footer HUD display
  useEffect(() => {
    if (selectedSceneId && scenes.length > 0) {
      const matched = scenes.find(s => s.id === selectedSceneId);
      if (matched) {
        let sensorName = "Sentinel-2 MSI";
        let res = "10 m";
        
        if (platform.includes("Landsat")) {
          sensorName = "Landsat C2 L2";
          res = "30 m";
        } else if (platform.includes("Sentinel-1")) {
          sensorName = "Sentinel-1 SAR";
          res = "10 m";
        }
        
        setSelectedSceneMeta({
          sensor: sensorName,
          resolution: res,
          date: matched.date,
          cloudCover: matched.cloud_cover !== null ? `${matched.cloud_cover.toFixed(1)}%` : "0%",
          sceneId: matched.id,
          orbit: matched.properties?.["sat:relative_orbit"] || matched.id.split("_")[4] || "N/A"
        });
      }
    } else {
      setSelectedSceneMeta(null);
    }
  }, [selectedSceneId, scenes, platform]);

  // 1. Search scenes in STAC catalog
  const triggerStacSearch = async () => {
    setSearchLoading(true);
    setScenes([]);
    setSelectedSceneId("");
    setSelectedSceneMeta(null);
    
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          bbox: [minLon, minLat, maxLon, maxLat],
          start_date: startDate,
          end_date: endDate,
          cloud_cover: cloudCover,
          orbit
        })
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Search query rejected");
      }
      
      const data = await res.json();
      setScenes(data.scenes);
      if (data.scenes.length > 0) {
        setSelectedSceneId(data.scenes[0].id);
        showToast(`Discovered ${data.scenes.length} available scenes`);
      } else {
        showToast("No telemetry scenes matched search windows.", true);
      }
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setSearchLoading(false);
    }
  };

  const clearMapOverlay = () => {
    if (imageOverlayRef.current && mapRef.current) {
      mapRef.current.removeLayer(imageOverlayRef.current);
      imageOverlayRef.current = null;
    }
  };

  const handleClearAll = () => {
    clearMapOverlay();
    setSpectralResult(null);
    setTimeSeriesResult(null);
    setLulcResult(null);
    setAefResult(null);
    setSimilarityResult(null);
    setQueryGeometry(null);
    setQueryFileName("");
    setCustomClusterNames({});
  };

  const renderRasterOverlay = (relativeUrl, bbox) => {
    if (!mapRef.current) return;
    
    clearMapOverlay();
    
    const imageUrl = `${API_BASE}${relativeUrl}`;
    const bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    
    const overlay = L.imageOverlay(imageUrl, bounds, {
      opacity: 0.85,
      interactive: false
    }).addTo(mapRef.current);
    
    imageOverlayRef.current = overlay;
    mapRef.current.fitBounds(bounds);
  };

  // 2. Run Spectral Monitor algebra
  const runSpectralCalculation = async (autoStretch = false) => {
    if (!selectedSceneId) {
      showToast("Select a scene acquisition timeline first.", true);
      return;
    }
    
    setLoading(true);
    setLoadingText("Streaming COG tiles & resolving indices...");
    setSpectralResult(null);

    try {
      const payload = {
        platform,
        item_id: selectedSceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        index: spectralIndex,
        formula: customFormula,
        palette: colorPalette,
        vis_min: autoStretch ? null : (visMin !== "" ? parseFloat(visMin) : null),
        vis_max: autoStretch ? null : (visMax !== "" ? parseFloat(visMax) : null),
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/spectral/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Calculation rejected");
      }

      const data = await res.json();
      setSpectralResult(data);
      setVisMin(data.vis_min.toFixed(3));
      setVisMax(data.vis_max.toFixed(3));
      
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast("Spectral calculations compiled successfully");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  const runTimeSeriesTrend = async () => {
    if (roiMethod === "file" && !uploadedGeoJson) {
      showToast("Upload a vector file first or choose Draw to select ROI.", true);
      return;
    }

    setTimeSeriesLoading(true);
    setLoading(true);
    setLoadingText("Streaming COG tiles & computing seasonal trends... This can take up to 20 seconds.");
    setTimeSeriesResult(null);

    try {
      const payload = {
        platform,
        bbox: [minLon, minLat, maxLon, maxLat],
        start_date: startDate,
        end_date: endDate,
        index: spectralIndex,
        formula: customFormula,
        cloud_cover: cloudCover,
        geometry: uploadedGeoJson,
        max_scenes: maxScenes
      };

      const res = await fetch(`${API_BASE}/api/spectral/time-series`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Time series trend calculation failed");
      }

      const data = await res.json();
      if (!data.timeseries || data.timeseries.length === 0) {
        throw new Error("No valid scenes processed in the selected date range.");
      }

      setTimeSeriesResult(data);
      setResultsPanelOpen(true);
      showToast("Time series trend generated successfully");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setTimeSeriesLoading(false);
      setLoading(false);
    }
  };

  const loadSpecificSceneRaster = async (sceneId, date) => {
    setLoading(true);
    setLoadingText(`Retrieving raster overlay for ${date}...`);
    try {
      const payload = {
        platform,
        item_id: sceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        index: spectralIndex,
        formula: customFormula,
        palette: colorPalette,
        vis_min: visMin !== "" ? parseFloat(visMin) : null,
        vis_max: visMax !== "" ? parseFloat(visMax) : null,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/spectral/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Raster compilation failed");
      }

      const data = await res.json();
      setSpectralResult(data);
      setVisMin(data.vis_min.toFixed(3));
      setVisMax(data.vis_max.toFixed(3));
      
      // Update selected scene metadata to reflect the selected date
      setSelectedSceneId(sceneId);
      
      // Update footer metadata display manually as well to be responsive
      let sensorName = "Sentinel-2 MSI";
      let resVal = "10 m";
      if (platform.includes("Landsat")) {
        sensorName = "Landsat C2 L2";
        resVal = "30 m";
      } else if (platform.includes("Sentinel-1")) {
        sensorName = "Sentinel-1 SAR";
        resVal = "10 m";
      }
      setSelectedSceneMeta({
        sensor: sensorName,
        resolution: resVal,
        date: date,
        cloudCover: data.density_bins ? "Calculated" : "0.0%",
        sceneId: sceneId,
        orbit: sceneId.split("_")[4] || "N/A"
      });

      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`Loaded map overlay for ${date}`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  // LULC Mapping calculation
  const runLulcCalculation = async () => {
    setLulcLoading(true);
    setLoading(true);
    setLoadingText(`Fetching ${lulcDataset === 'esa-worldcover' ? 'ESA WorldCover' : 'IO LULC Annual'} for ${lulcYear}...`);
    setLulcResult(null);

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        dataset: lulcDataset,
        year: lulcYear,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/lulc/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "LULC calculation failed");
      }

      const data = await res.json();
      setLulcResult(data);
      setResultsPanelOpen(true);

      // Render the colorized classification on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`LULC map generated for ${lulcYear}`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLulcLoading(false);
      setLoading(false);
    }
  };

  // AEF AI Clustering calculation
  const runAefClustering = async () => {
    setAefLoading(true);
    setLoading(true);
    setLoadingText(`Running AI Clustering using AlphaEarth Embeddings for ${aefYear}...`);
    setAefResult(null);
    setCustomClusterNames({});

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        year: aefYear,
        num_clusters: aefClusters,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/aef/cluster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "AI Clustering failed");
      }

      const data = await res.json();
      setAefResult(data);
      setResultsPanelOpen(true);

      // Render the colorized classification on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`AI Clustering completed with ${aefClusters} classes`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setAefLoading(false);
      setLoading(false);
    }
  };

  // AEF AI Similarity calculation
  const runAefSimilarity = async () => {
    if (!uploadedGeoJson) {
      showToast("Draw or select a Target ROI first.", true);
      return;
    }
    if (!queryGeometry) {
      showToast("Please draw a Query Feature polygon inside the ROI first.", true);
      return;
    }

    setSimilarityLoading(true);
    setLoading(true);
    setLoadingText(`Calculating AI Similarity using AlphaEarth Embeddings for ${aefYear}...`);
    setSimilarityResult(null);

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        year: aefYear,
        query_geometry: queryGeometry,
        threshold: aefThreshold,
        mode: aefSimMode,
        geometry: uploadedGeoJson,
        palette: colorPalette
      };

      const res = await fetch(`${API_BASE}/api/aef/similarity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "AI Similarity calculation failed");
      }

      const data = await res.json();
      setSimilarityResult(data);
      setResultsPanelOpen(true);

      // Render the colorized similarity map on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`AI Similarity Search completed successfully`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setSimilarityLoading(false);
      setLoading(false);
    }
  };

  // Reset overlays on tab switch
  useEffect(() => {
    clearMapOverlay();
  }, [activeTab]);

  // Export metadata as JSON file
  const exportSceneMetadata = () => {
    if (!selectedSceneMeta) {
      showToast("No active scene selected.", true);
      return;
    }
    const sceneObject = scenes.find(s => s.id === selectedSceneId);
    const jsonStr = JSON.stringify(sceneObject || selectedSceneMeta, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Metadata_${selectedSceneMeta.sceneId}.json`;
    a.click();
    showToast("Metadata exported successfully");
  };



  // Color bar hex colors for map overlay legends
  const getPaletteGradientString = () => {
    const list = get_color_palette(colorPalette);
    return `linear-gradient(90deg, ${list.join(', ')})`;
  };

  const activeTiffUrl = 
    analysisMode === "aef" && aefResult ? aefResult.geotiff_url :
    analysisMode === "lulc" && lulcResult ? lulcResult.geotiff_url :
    analysisMode === "similarity" && similarityResult ? similarityResult.geotiff_url :
    spectralResult ? spectralResult.geotiff_url : null;

  return (
    <div className="app-viewport">
      
      {/* Dynamic Alert Toast */}
      {toast && (
        <div className={`toast-msg ${toast.isError ? 'error' : ''}`}>
          {toast.isError ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Loading overlay panel */}
      {loading && (
        <div className="loading-overlay">
          <div className="loading-schematic">
            {/* Orbital rings */}
            <div className="orbital-ring ring-1"></div>
            <div className="orbital-ring ring-2"></div>
            <div className="orbital-ring ring-3"></div>
            {/* Center core */}
            <div className="loading-core">
              <Satellite size={28} className="loading-core-icon" />
            </div>
            {/* Orbiting nodes */}
            <div className="orbit-node node-1"></div>
            <div className="orbit-node node-2"></div>
            <div className="orbit-node node-3"></div>
          </div>
          <div className="loading-text">{loadingText}</div>
          <div className="loading-steps">
            <div className="load-step active"><span className="step-dot"></span> Connecting to STAC</div>
            <div className="load-step active"><span className="step-dot"></span> Fetching COG tiles</div>
            <div className="load-step"><span className="step-dot"></span> Processing raster</div>
            <div className="load-step"><span className="step-dot"></span> Rendering output</div>
          </div>
          {/* Scan line effect */}
          <div className="scan-line"></div>
        </div>
      )}

      {/* HUD HEADER */}
      <header className="hud-header">
        <div className="hud-title">
          <img src="/logo.png" alt="PhytoLens Logo" className="hud-logo-img" />
        </div>

        {/* Global Map Controls */}
        <div className="flex items-center gap-3 bg-slate-900/40 px-3 py-1.5 rounded border border-cyan-500/10">
          <button 
            onClick={() => setBaseMap("satellite")} 
            className={`pill-btn ${baseMap === "satellite" ? "active" : ""}`}
            style={{ padding: '4px 8px', fontSize: '10px' }}
          >
            Satellite
          </button>
          <button 
            onClick={() => setBaseMap("streets")} 
            className={`pill-btn ${baseMap === "streets" ? "active" : ""}`}
            style={{ padding: '4px 8px', fontSize: '10px' }}
          >
            Streets
          </button>
          <div style={{ borderLeft: '1px solid var(--border-color)', height: '14px', margin: '0 4px' }}></div>
          <span className="text-[10px] text-slate-500 font-bold select-none">OPACITY:</span>
          <input 
            type="range" min="0.1" max="1.0" step="0.1" 
            value={overlayOpacity} 
            onChange={e => setOverlayOpacity(parseFloat(e.target.value))} 
            style={{ width: '60px', accentColor: 'var(--accent-sky)', cursor: 'pointer' }} 
          />
        </div>

        <div className="flex items-center gap-6">
          <div className="hud-system-status">
            <span className="status-dot"></span>
            <span>UPLINK ACTIVE</span>
          </div>

          <div className="hud-time-block">
            <span>SYS_TIME:</span>
            <span className="hud-time-val">{systemTime}</span>
          </div>

          <div className="flex items-center gap-2">
            <button className="icon-btn-round" title="System Status: Online" onClick={() => showToast("System Status: 100% Operational")}>?</button>
            <button className="icon-btn-round" title="Quick Refresh" onClick={() => {
              handleClearAll();
              showToast("Map layers cleared.");
            }}>
              <RefreshCw size={14} className="header-icon-btn" />
            </button>
          </div>

          <div className="hud-profile-badge" title="User Profile: Nitesh Kumar">
            NK
          </div>
        </div>
      </header>

      {/* Main Workspace layout */}
      <div className="app-container">
        
        {/* LEFT CONTROL SIDEBAR */}
        <aside className="sidebar">
          
          {/* CARD 1: ANALYSIS MODE */}
          <div className="sidebar-card">
            <div className="card-header">
              <Layers className="icon" />
              <h2>ANALYSIS MODE</h2>
            </div>
            <div className="card-body">
              <div className="custom-select">
                <select 
                  value={analysisMode} 
                  onChange={e => {
                    setAnalysisMode(e.target.value);
                    handleClearAll();
                  }}
                >
                  <option value="single">Single Scene Scan</option>
                  <option value="timeseries">Seasonal Trend</option>
                  <option value="lulc">LULC Mapping</option>
                  <option value="aef">AI Clustering (AEF)</option>
                  <option value="similarity">AI Similarity (AEF)</option>
                </select>
              </div>
            </div>
          </div>

          {/* CARD 2: TARGET ROI CONFIGURATION */}
          <div className="sidebar-card">
            <div className="card-header">
              <Compass className="icon" />
              <h2>TARGET ROI</h2>
            </div>
            <div className="card-body">
              {/* Two-button ROI method selector */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  onClick={() => { stopDrawMode(); setRoiMethod('file'); }}
                  className={`radio-button flex-1 justify-center ${roiMethod === 'file' ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <Upload size={13} /> Upload
                </button>
                <button 
                  onClick={isDrawing ? stopDrawMode : startDrawMode}
                  className={`radio-button flex-1 justify-center ${roiMethod === 'draw' ? 'active' : ''} ${isDrawing ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <PenTool size={13} /> {isDrawing ? 'Drawing...' : 'Draw'}
                </button>
              </div>

              {/* File Upload Section */}
              {roiMethod === "file" && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <div className="file-upload-box">
                    <input type="file" accept=".kml,.geojson,.json" onChange={handleFileUpload} className="file-upload-input" />
                    <Upload size={16} className="text-cyan-400 mb-1" />
                    <span className="file-upload-text">{uploadedFileName || "Click to browse vector"}</span>
                    <span className="file-upload-subtext">Supports .kml, .geojson, .json</span>
                  </div>
                </div>
              )}

              {/* Draw mode active indicator */}
              {roiMethod === "draw" && (
                <div className="p-2 bg-slate-900/40 border border-cyan-500/10 rounded flex items-center gap-2" style={{ marginBottom: 0 }}>
                  {isDrawing ? (
                    <>
                      <span className="badge-pulse"></span>
                      <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Click on map to draw polygon vertices</span>
                      <button onClick={stopDrawMode} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', padding: '2px' }}>
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <span className="text-[10px] text-slate-400">
                      ROI: {minLat.toFixed(4)}°N, {minLon.toFixed(4)}°E → {maxLat.toFixed(4)}°N, {maxLon.toFixed(4)}°E
                    </span>
                  )}
                </div>
              )}

              {/* Show loaded file info */}
              {roiMethod === "file" && uploadedFileName && (
                <div className="flex items-center gap-2 text-[10px] text-slate-400" style={{ marginTop: '-4px' }}>
                  <FileCheck size={12} className="text-cyan-400" />
                  <span className="text-white font-bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadedFileName}</span>
                </div>
              )}
            </div>
          </div>

          {/* CARD 3: SATELLITE SCENE TIMELINE — hidden in LULC/AEF/Similarity mode */}
          {(analysisMode !== "lulc" && analysisMode !== "aef" && analysisMode !== "similarity") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Calendar className="icon" />
              <h2>SCENE ACQUISITION</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Satellite Network</label>
                <div className="custom-select">
                  <select 
                    value={platform} 
                    onChange={e => {
                      setPlatform(e.target.value);
                      setSelectedSceneId("");
                      setScenes([]);
                    }} 
                  >
                    <option value="Sentinel-2 (Optical)">Sentinel-2 MSI</option>
                    <option value="Landsat 8 (Optical)">Landsat 8 C2 L2</option>
                    <option value="Landsat 9 (Optical)">Landsat 9 C2 L2</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="form-group">
                  <label>Start Date</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-cyber" />
                </div>
                <div className="form-group">
                  <label>End Date</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input-cyber" />
                </div>
              </div>

              <div className="form-group">
                <label>Cloud Tolerance ({cloudCover}%)</label>
                <input type="range" min="0" max="100" value={cloudCover} onChange={e => setCloudCover(parseInt(e.target.value))} />
              </div>

              <button 
                onClick={triggerStacSearch} 
                disabled={searchLoading} 
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2"
              >
                <RefreshCw className={searchLoading ? "animate-spin" : ""} size={12} />
                {searchLoading ? "Querying STAC..." : "Query Satellite Items"}
              </button>

              {analysisMode === "single" && scenes.length > 0 && (
                <div className="form-group mt-2">
                  <label>Select Scene Timeline ({scenes.length})</label>
                  <div className="custom-select">
                    <select 
                      value={selectedSceneId} 
                      onChange={e => {
                        setSelectedSceneId(e.target.value);
                        clearMapOverlay();
                      }} 
                      className="font-mono text-xs"
                    >
                      {scenes.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.date} - {s.id.substring(0, 15)}... {s.cloud_cover !== null ? `(${s.cloud_cover.toFixed(0)}% Cloud)` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {analysisMode === "timeseries" && (
                <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                  <span className="text-cyan-400 font-bold uppercase tracking-wider">Seasonal Trend Query</span>
                  <p className="leading-relaxed text-slate-400">
                    No single scene selection needed. The system will extract & compute statistics for all clear satellite captures within the selected season.
                  </p>
                </div>
              )}
            </div>
          </div>
          )}

          {/* CARD 3b: LULC CONFIGURATION — visible only in LULC mode */}
          {analysisMode === "lulc" && (
          <div className="sidebar-card">
            <div className="card-header">
              <MapPin className="icon" />
              <h2>LULC CONFIGURATION</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>LULC Dataset</label>
                <div className="custom-select">
                  <select 
                    value={lulcDataset} 
                    onChange={e => {
                      setLulcDataset(e.target.value);
                      // Reset year to valid default for the dataset
                      if (e.target.value === 'esa-worldcover') setLulcYear(2021);
                      else setLulcYear(2022);
                    }}
                  >
                    <option value="esa-worldcover">ESA WorldCover (10 m)</option>
                    <option value="io-lulc">IO LULC Annual v02 (10 m)</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Year</label>
                <div className="custom-select">
                  <select value={lulcYear} onChange={e => setLulcYear(parseInt(e.target.value))}>
                    {lulcDataset === 'esa-worldcover' ? (
                      <>
                        <option value={2021}>2021</option>
                        <option value={2020}>2020</option>
                      </>
                    ) : (
                      <>
                        <option value={2023}>2023</option>
                        <option value={2022}>2022</option>
                        <option value={2021}>2021</option>
                        <option value={2020}>2020</option>
                        <option value={2019}>2019</option>
                        <option value={2018}>2018</option>
                        <option value={2017}>2017</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  {lulcDataset === 'esa-worldcover' ? 'ESA WorldCover' : 'Impact Observatory'}
                </span>
                <p className="leading-relaxed text-slate-400">
                  {lulcDataset === 'esa-worldcover' 
                    ? 'Sentinel-1 & Sentinel-2 derived 11-class land cover map at 10 m resolution. Available for 2020 and 2021.'
                    : 'Deep-learning 9-class annual land cover from Sentinel-2 imagery at 10 m resolution. Available 2017–2023.'
                  }
                </p>
              </div>

              <button 
                onClick={runLulcCalculation} 
                disabled={lulcLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <MapPin size={12} className={lulcLoading ? "animate-spin" : ""} />
                {lulcLoading ? "Generating LULC Map..." : "Generate LULC Map"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3c: AEF CLUSTERING CONFIGURATION — visible only in AEF mode */}
          {analysisMode === "aef" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Cpu className="icon" />
              <h2>AI CLUSTERING</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Acquisition Year</label>
                <div className="custom-select">
                  <select value={aefYear} onChange={e => setAefYear(parseInt(e.target.value))}>
                    <option value={2025}>2025 (Embeddings)</option>
                    <option value={2024}>2024 (Embeddings)</option>
                    <option value={2023}>2023 (Embeddings)</option>
                    <option value={2022}>2022 (Embeddings)</option>
                    <option value={2019}>2019 (Embeddings)</option>
                    <option value={2018}>2018 (Embeddings)</option>
                    <option value={2017}>2017 (Embeddings)</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Number of Clusters ({aefClusters})</label>
                <input 
                  type="range" 
                  min="2" 
                  max="10" 
                  value={aefClusters} 
                  onChange={e => setAefClusters(parseInt(e.target.value))} 
                />
              </div>

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  AlphaEarth Foundations (AEF)
                </span>
                <p className="leading-relaxed text-slate-400">
                  Performs unsupervised K-Means clustering on Google DeepMind's 64-dimensional satellite embeddings sourced from the AWS opendata bucket.
                </p>
              </div>

              <button 
                onClick={runAefClustering} 
                disabled={aefLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Cpu size={12} className={aefLoading ? "animate-spin" : ""} />
                {aefLoading ? "Clustering Embeddings..." : "Generate AI Clusters"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3d: AI SIMILARITY CONFIGURATION — visible only in similarity mode */}
          {analysisMode === "similarity" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Cpu className="icon" />
              <h2>AI SIMILARITY</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Acquisition Year</label>
                <div className="custom-select">
                  <select value={aefYear} onChange={e => setAefYear(parseInt(e.target.value))}>
                    <option value={2025}>2025 (Embeddings)</option>
                    <option value={2024}>2024 (Embeddings)</option>
                    <option value={2023}>2023 (Embeddings)</option>
                    <option value={2022}>2022 (Embeddings)</option>
                    <option value={2019}>2019 (Embeddings)</option>
                    <option value={2018}>2018 (Embeddings)</option>
                    <option value={2017}>2017 (Embeddings)</option>
                  </select>
                </div>
              </div>

              {/* Draw Query Feature Button */}
              <div className="form-group">
                <label>Query Feature Geometry</label>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={isDrawing ? stopDrawMode : () => startDrawMode("query")}
                    className={`radio-button w-full justify-center ${drawingTarget === 'query' && isDrawing ? 'active' : ''}`}
                    style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                  >
                    <PenTool size={13} /> {drawingTarget === 'query' && isDrawing ? 'Drawing Feature...' : 'Draw Query Feature'}
                  </button>

                  <div className="flex items-center gap-2 text-[9px] text-slate-600 uppercase tracking-wider">
                    <div className="flex-1 h-px bg-slate-700/60" /> or <div className="flex-1 h-px bg-slate-700/60" />
                  </div>

                  <div className="file-upload-box" style={{ padding: '8px' }}>
                    <input type="file" accept=".kml,.geojson,.json" onChange={handleQueryFileUpload} className="file-upload-input" />
                    <Upload size={14} className="text-amber-400 mb-1" />
                    <span className="file-upload-text">Upload Query Feature</span>
                    <span className="file-upload-subtext">Supports .kml, .geojson, .json</span>
                  </div>

                  {queryFileName ? (
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 p-1.5 bg-slate-900/40 rounded border border-amber-500/20">
                      <FileCheck size={12} className="text-amber-500" />
                      <span className="text-white font-bold truncate">{queryFileName}</span>
                      <button
                        onClick={() => { setQueryGeometry(null); setQueryFileName(""); }}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <span className="text-[9px] text-slate-500">No query feature yet. Draw or upload a small area inside the ROI.</span>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label>Color Palette</label>
                <div className="custom-select">
                  <select value={colorPalette} onChange={e => setColorPalette(e.target.value)}>
                    <option value="Viridis (Sequential)">Viridis (Sequential)</option>
                    <option value="Magma (Sequential)">Magma (Sequential)</option>
                    <option value="Plasma (Sequential)">Plasma</option>
                    <option value="Turbo (Rainbow Enhanced)">Turbo (Rainbow)</option>
                    <option value="Terrain (Elevation)">Terrain (Elevation)</option>
                    <option value="Red-Yellow-Green (Vegetation)">Red-Yellow-Green (Veg)</option>
                    <option value="Blue-White-Green (Water/Veg)">Blue-White-Green (Water)</option>
                    <option value="Blue-Yellow-Red (Thermal)">Blue-Yellow-Red (Thermal)</option>
                    <option value="Greyscale">Greyscale</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Similarity Mode</label>
                <div className="custom-select">
                  <select
                    value={aefSimMode}
                    onChange={e => {
                      const m = e.target.value;
                      setAefSimMode(m);
                      // Reset threshold to the mode's sensible default
                      setAefThreshold(m === "dotproduct" ? 0.9 : 0.5);
                    }}
                  >
                    <option value="centered">Local Contrast (recommended)</option>
                    <option value="dotproduct">Absolute / Dot-product (Google)</option>
                  </select>
                </div>
                <span className="text-[9px] text-slate-400 mt-1 block">
                  {aefSimMode === "dotproduct"
                    ? "Google's raw dot-product. Best for diverse scenes; in uniform terrain distinct features (e.g. water) may rank low."
                    : "Mean-centered cosine. Removes the component all pixels share so distinct features (water, built-up) are ranked correctly."}
                </span>
              </div>

              <div className="form-group">
                <label>Similarity Threshold ({aefThreshold.toFixed(3)})</label>
                <input
                  type="range"
                  min="0.000"
                  max="1.000"
                  step="0.001"
                  value={aefThreshold}
                  onChange={e => setAefThreshold(parseFloat(e.target.value))}
                />
                <span className="text-[9px] text-slate-400 mt-1 block">
                  {aefSimMode === "dotproduct"
                    ? "Dot-product similarity (1 = identical). ~0.90 is Google's default; raise to tighten."
                    : "Centered similarity (1 = identical, 0 = ROI average). ~0.50 isolates the query feature; raise to tighten."}
                </span>
              </div>



              <button 
                onClick={runAefSimilarity} 
                disabled={similarityLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Cpu size={12} className={similarityLoading ? "animate-spin" : ""} />
                {similarityLoading ? "Computing Similarity..." : "Run Similarity Search"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 4: ANALYTICS PARAMETERS — hidden in LULC/AEF/Similarity mode */}
          {(analysisMode !== "lulc" && analysisMode !== "aef" && analysisMode !== "similarity") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Sliders className="icon" />
              <h2>PARAMETERS</h2>
            </div>
            <div className="card-body">
              <div className="flex flex-col gap-3">
                <div className="form-group">
                  <label>Spectral Index</label>
                  <div className="custom-select">
                    <select value={spectralIndex} onChange={e => setSpectralIndex(e.target.value)}>
                      <option value="NDVI">NDVI (Vegetation health)</option>
                      <option value="GNDVI">GNDVI (Chlorophyll index)</option>
                      <option value="NDWI (Water)">NDWI (Water body mapping)</option>
                      <option value="NDMI">NDMI (Moisture content)</option>
                      {platform.includes("Landsat") && <option value="LST (Thermal)">LST (Brightness Temp)</option>}
                      <option value="🛠️ Custom (Band Math)">🛠️ Custom (Band Math)</option>
                    </select>
                  </div>
                </div>

                {spectralIndex === "🛠️ Custom (Band Math)" && (
                  <div className="form-group">
                    <label>Algebra Expression</label>
                    <input type="text" value={customFormula} onChange={e => setCustomFormula(e.target.value)} className="input-cyber" />
                    <span className="text-[9px] text-slate-400 mt-1 block">e.g. (B08-B04)/(B08+B04)</span>
                  </div>
                )}

                <div className="form-group">
                  <label>Color Palette</label>
                  <div className="custom-select">
                    <select value={colorPalette} onChange={e => setColorPalette(e.target.value)}>
                      <option value="Red-Yellow-Green (Vegetation)">Red-Yellow-Green (Veg)</option>
                      <option value="Blue-White-Green (Water/Veg)">Blue-White-Green (Water)</option>
                      <option value="Blue-Yellow-Red (Thermal)">Blue-Yellow-Red (Thermal)</option>
                      <option value="Viridis (Sequential)">Viridis (Sequential)</option>
                      <option value="Magma (Sequential)">Magma (Sequential)</option>
                      <option value="Plasma (Sequential)">Plasma</option>
                      <option value="Turbo (Rainbow Enhanced)">Turbo (Rainbow)</option>
                      <option value="Terrain (Elevation)">Terrain (Elevation)</option>
                      <option value="Greyscale">Greyscale</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="form-group">
                    <label>Stretch Min</label>
                    <input type="number" step="0.1" value={visMin} onChange={e => setVisMin(e.target.value)} className="input-cyber" />
                  </div>
                  <div className="form-group">
                    <label>Stretch Max</label>
                    <input type="number" step="0.1" value={visMax} onChange={e => setVisMax(e.target.value)} className="input-cyber" />
                  </div>
                </div>

                {analysisMode === "timeseries" && (
                  <div className="form-group">
                    <label>Max Scenes to Scan ({maxScenes})</label>
                    <input 
                      type="range" 
                      min="5" 
                      max="30" 
                      value={maxScenes} 
                      onChange={e => setMaxScenes(parseInt(e.target.value))} 
                    />
                    <span className="text-[9px] text-slate-400 mt-1 block">Fewer scenes process faster. Subsamples evenly if more exist.</span>
                  </div>
                )}

                {analysisMode === "single" ? (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button onClick={() => runSpectralCalculation(true)} className="reset-btn-pill active py-2 text-xs flex-1">
                      Auto Stretch
                    </button>
                    <button onClick={() => runSpectralCalculation(false)} className="submit-btn-pill active py-2 text-xs flex-1">
                      Scan Scene
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={runTimeSeriesTrend} 
                    disabled={timeSeriesLoading}
                    className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-1"
                  >
                    <Activity size={12} className={timeSeriesLoading ? "animate-spin" : ""} />
                    {timeSeriesLoading ? "Computing Trend..." : "Run Time Series Trend"}
                  </button>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Legend removed from here and placed in footer */}

          {/* CARD 6: INFO BOX */}
          <div className="info-box-card">
            <Activity className="icon-info" />
            <p>
              Calculates index formulas from multispectral bands (S2/Landsat COGs) dynamically stretched over the target bounds.
            </p>
          </div>
        </aside>

        {/* CENTRAL MAP WORKSPACE */}
        <section className="workspace">

          <div className="map-container">
            <div id="leaflet-map" ref={mapContainerRef}></div>
          </div>

          {/* FLOATING CONTROL OVERLAYS ON MAP */}
          <div className="map-top-bar">
            {/* Lat/Lon Search Box */}
            <form onSubmit={handleSearchSubmit} className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="search-icon" style={{ width: '16px', height: '16px', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input 
                type="text" 
                placeholder="Search coords (lat, lon)..." 
                value={searchCoords}
                onChange={e => setSearchCoords(e.target.value)}
              />
            </form>
          </div>

          {/* Custom Vertical Map Controls on the Right */}
          <div className="custom-map-controls">
            <button className="control-btn" onClick={() => mapRef.current?.zoomIn()} title="Zoom In">+</button>
            <button className="control-btn" onClick={() => mapRef.current?.zoomOut()} title="Zoom Out">-</button>
            <div className="control-divider"></div>
            <button className="control-btn" onClick={() => {
              if (mapRef.current) {
                if (roiMethod === "file" && geoJsonLayerRef.current) {
                  mapRef.current.fitBounds(geoJsonLayerRef.current.getBounds());
                } else {
                  mapRef.current.fitBounds([[minLat, minLon], [maxLat, maxLon]]);
                }
              }
            }} title="Reset Zoom to ROI bounds">
              <Compass size={14} className="control-icon" />
            </button>
            <button className="control-btn" onClick={handleLocateClient} title="Center GPS location">
              <span style={{ fontSize: '13px' }}>🎯</span>
            </button>
            <button className="control-btn" onClick={toggleFullscreen} title="Toggle Map Fullscreen">
              <span style={{ fontSize: '13px' }}>{isFullscreen ? "🗜" : "📺"}</span>
            </button>
          </div>

          {/* Coordinate Overlay Tracker (bottom right) */}
          <div className="coordinate-overlay-pill">
            <span className="badge-pulse"></span>
            <span>
              {hoverCoords 
                ? `${hoverCoords.lat.toFixed(5)}° N, ${hoverCoords.lng.toFixed(5)}° E` 
                : `${pointLat.toFixed(5)}° N, ${pointLon.toFixed(5)}° E`}
            </span>
          </div>

          {/* FLOATING SIDEBAR RIGHT - RESULTS OVERLAY */}
          {((spectralResult && analysisMode === "single") || 
            (timeSeriesResult && analysisMode === "timeseries") || 
            (lulcResult && analysisMode === "lulc") || 
            (aefResult && analysisMode === "aef") || 
            (similarityResult && analysisMode === "similarity")) && (
            <>
            <button 
              className={`results-toggle-btn ${!resultsPanelOpen ? 'collapsed' : ''}`}
              onClick={() => setResultsPanelOpen(prev => !prev)}
              title={resultsPanelOpen ? "Hide Results Panel" : "Show Results Panel"}
              style={{ right: resultsPanelOpen ? resultsWidth : 0 }}
            >
              {resultsPanelOpen ? '›' : '‹'}
            </button>
            <div 
              className={`results-overlay ${!resultsPanelOpen ? 'collapsed' : ''}`}
              style={{ width: resultsWidth }}
            >
              {/* Resize Handle Drag Bar */}
              <div 
                className="resize-handle" 
                onMouseDown={startResize} 
                title="Drag to resize panel width"
              />

              {/* TAB 1: SPECTRAL MONITOR RESULTS */}
              {spectralResult && analysisMode === "single" && (
                <div className="glass-panel p-4">
                  <div className="results-header">
                    <span>📈 {spectralIndex} ANALYTICS</span>
                    <Activity size={14} className="text-cyan-400" />
                  </div>
                  
                  <div className="stats-grid">
                    <div className="stat-card">
                      <div className="stat-label">Mean</div>
                      <div className="stat-val high">{spectralResult.stats.mean.toFixed(3)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Std Dev</div>
                      <div className="stat-val">{spectralResult.stats.std.toFixed(3)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Min</div>
                      <div className="stat-val danger">{spectralResult.stats.min.toFixed(3)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Max</div>
                      <div className="stat-val success">{spectralResult.stats.max.toFixed(3)}</div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-800/60 flex flex-col gap-2">
                    <button 
                      onClick={() => renderRasterOverlay(spectralResult.image_url, [minLon, minLat, maxLon, maxLat])}
                      className="radio-button py-2 text-xs justify-center items-center flex gap-1 border-dashed w-full"
                    >
                      <Eye size={14} /> View Image Overlay
                    </button>
                  </div>
                </div>
              )}

              {/* TIME SERIES RESULTS */}
              {timeSeriesResult && analysisMode === "timeseries" && (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>📈 SEASONAL {spectralIndex} TREND</span>
                    <Activity size={14} className="text-cyan-400" />
                  </div>
                  
                  <TimeSeriesChart 
                    data={timeSeriesResult.timeseries} 
                    indexName={spectralIndex} 
                    onViewScene={loadSpecificSceneRaster}
                    activeSceneId={selectedSceneId}
                  />
                </div>
              )}

              {/* LULC MAPPING RESULTS */}
              {lulcResult && analysisMode === "lulc" && (() => {
                const statsEntries = Object.entries(lulcResult.stats).sort((a, b) => b[1].percentage - a[1].percentage);
                const totalArea = statsEntries.reduce((sum, [, v]) => sum + v.area_ha, 0);

                // Donut chart calculations
                const donutSize = 160;
                const donutR = 58;
                const donutInnerR = 36;
                const donutCx = donutSize / 2;
                const donutCy = donutSize / 2;
                let donutAngle = -90; // start from top

                const donutSegments = statsEntries.map(([classVal, info]) => {
                  const angleDeg = (info.percentage / 100) * 360;
                  const startAngle = donutAngle;
                  donutAngle += angleDeg;
                  const endAngle = donutAngle;

                  const startRad = (startAngle * Math.PI) / 180;
                  const endRad = (endAngle * Math.PI) / 180;

                  const x1 = donutCx + donutR * Math.cos(startRad);
                  const y1 = donutCy + donutR * Math.sin(startRad);
                  const x2 = donutCx + donutR * Math.cos(endRad);
                  const y2 = donutCy + donutR * Math.sin(endRad);

                  const ix1 = donutCx + donutInnerR * Math.cos(endRad);
                  const iy1 = donutCy + donutInnerR * Math.sin(endRad);
                  const ix2 = donutCx + donutInnerR * Math.cos(startRad);
                  const iy2 = donutCy + donutInnerR * Math.sin(startRad);

                  const largeArc = angleDeg > 180 ? 1 : 0;

                  const pathD = [
                    `M ${x1} ${y1}`,
                    `A ${donutR} ${donutR} 0 ${largeArc} 1 ${x2} ${y2}`,
                    `L ${ix1} ${iy1}`,
                    `A ${donutInnerR} ${donutInnerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
                    'Z'
                  ].join(' ');

                  return { classVal, info, pathD };
                });

                // CSV Export for LULC
                const handleLulcCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Class,Pixels,Area_Ha,Percentage\n";
                  statsEntries.forEach(([, info]) => {
                    csvContent += `${info.name},${info.pixel_count},${info.area_ha},${info.percentage}\n`;
                  });
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `LULC_${lulcResult.dataset}_${lulcResult.year}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>🗺️ LULC CLASSIFICATION — {lulcResult.year}</span>
                    <MapPin size={14} className="text-cyan-400" />
                  </div>

                  <div className="text-[10px] text-slate-400 flex items-center gap-2">
                    <span className="text-cyan-400 font-bold uppercase">
                      {lulcResult.dataset === 'esa-worldcover' ? 'ESA WorldCover' : 'IO LULC Annual v02'}
                    </span>
                    <span>•</span>
                    <span>{statsEntries.length} classes detected</span>
                    <span>•</span>
                    <span>{totalArea.toFixed(1)} ha total</span>
                  </div>

                  {/* Categorical Legend */}
                  <div className="lulc-legend-grid">
                    {statsEntries.map(([classVal, info]) => (
                      <div key={classVal} className="lulc-legend-item">
                        <span className="lulc-color-swatch" style={{ backgroundColor: info.color }}></span>
                        <span className="lulc-legend-name">{info.name}</span>
                        <span className="lulc-legend-pct">{info.percentage.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>

                  {/* Horizontal Stacked Bar Chart */}
                  <div className="lulc-section-title">Coverage Distribution</div>
                  <div className="lulc-bar-chart">
                    {statsEntries.map(([classVal, info]) => (
                      <div 
                        key={classVal}
                        className="lulc-bar-segment"
                        style={{ 
                          width: `${Math.max(info.percentage, 0.5)}%`, 
                          backgroundColor: info.color 
                        }}
                        title={`${info.name}: ${info.percentage.toFixed(1)}%`}
                      ></div>
                    ))}
                  </div>

                  {/* SVG Donut Chart */}
                  <div className="lulc-section-title">Class Proportion</div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <svg width={donutSize} height={donutSize} viewBox={`0 0 ${donutSize} ${donutSize}`}>
                      {donutSegments.map((seg, idx) => (
                        <path
                          key={idx}
                          d={seg.pathD}
                          fill={seg.info.color}
                          stroke="#1a1f2e"
                          strokeWidth="1"
                          style={{ cursor: 'pointer' }}
                        >
                          <title>{seg.info.name}: {seg.info.percentage.toFixed(1)}%</title>
                        </path>
                      ))}
                      {/* Center label */}
                      <text x={donutCx} y={donutCy - 4} textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="700">
                        {statsEntries.length}
                      </text>
                      <text x={donutCx} y={donutCy + 10} textAnchor="middle" fill="#94a3b8" fontSize="8">
                        Classes
                      </text>
                    </svg>
                  </div>

                  {/* Statistics Table */}
                  <div className="lulc-section-title">Area Statistics</div>
                  <div className="mt-1 overflow-y-auto max-h-[180px] border border-slate-700/60 rounded">
                    <table className="lulc-stats-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>Class</th>
                          <th>Pixels</th>
                          <th>Area (ha)</th>
                          <th>%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statsEntries.map(([classVal, info]) => (
                          <tr key={classVal}>
                            <td><span className="lulc-color-swatch-sm" style={{ backgroundColor: info.color }}></span></td>
                            <td className="font-bold" style={{ color: info.color }}>{info.name}</td>
                            <td>{info.pixel_count.toLocaleString()}</td>
                            <td>{info.area_ha.toFixed(1)}</td>
                            <td style={{ fontWeight: 'bold' }}>{info.percentage.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Export CSV */}
                  <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-700/60">
                    <span className="text-[10px] text-slate-500 font-bold">
                      Total: {totalArea.toFixed(1)} ha
                    </span>
                    <button onClick={handleLulcCsvExport} className="excel-btn">
                      Export CSV
                    </button>
                  </div>
                </div>
                );
              })()}

              {/* AI CLUSTERING RESULTS */}
              {aefResult && analysisMode === "aef" && (() => {
                const statsEntries = Object.entries(aefResult.stats).sort((a, b) => b[1].percentage - a[1].percentage);
                const totalArea = statsEntries.reduce((sum, [, v]) => sum + v.area_ha, 0);

                // Donut chart calculations
                const donutSize = 160;
                const donutR = 58;
                const donutInnerR = 36;
                const donutCx = donutSize / 2;
                const donutCy = donutSize / 2;
                let donutAngle = -90;

                const donutSegments = statsEntries.map(([classVal, info]) => {
                  const angleDeg = (info.percentage / 100) * 360;
                  const startAngle = donutAngle;
                  donutAngle += angleDeg;
                  const endAngle = donutAngle;

                  const startRad = (startAngle * Math.PI) / 180;
                  const endRad = (endAngle * Math.PI) / 180;

                  const x1 = donutCx + donutR * Math.cos(startRad);
                  const y1 = donutCy + donutR * Math.sin(startRad);
                  const x2 = donutCx + donutR * Math.cos(endRad);
                  const y2 = donutCy + donutR * Math.sin(endRad);

                  const ix1 = donutCx + donutInnerR * Math.cos(endRad);
                  const iy1 = donutCy + donutInnerR * Math.sin(endRad);
                  const ix2 = donutCx + donutInnerR * Math.cos(startRad);
                  const iy2 = donutCy + donutInnerR * Math.sin(startRad);

                  const largeArc = angleDeg > 180 ? 1 : 0;

                  const pathD = [
                    `M ${x1} ${y1}`,
                    `A ${donutR} ${donutR} 0 ${largeArc} 1 ${x2} ${y2}`,
                    `L ${ix1} ${iy1}`,
                    `A ${donutInnerR} ${donutInnerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
                    'Z'
                  ].join(' ');

                  return { classVal, info, pathD };
                });

                // CSV Export for AEF Cluster
                const handleAefCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Cluster,Custom Label,Pixels,Area_Ha,Percentage\n";
                  statsEntries.forEach(([classVal, info]) => {
                    const customLabel = customClusterNames[classVal] || info.name;
                    csvContent += `"${info.name}","${customLabel.replace(/"/g, '""')}",${info.pixel_count},${info.area_ha},${info.percentage}\n`;
                  });
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `AEF_Clustering_${aefResult.year}_K${aefResult.num_clusters}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>🤖 AI CLUSTERING — {aefResult.year}</span>
                    <Cpu size={14} className="text-cyan-400" />
                  </div>

                  <div className="text-[10px] text-slate-400 flex items-center gap-2">
                    <span className="text-cyan-400 font-bold uppercase">
                      AlphaEarth K-Means
                    </span>
                    <span>•</span>
                    <span>{statsEntries.length} clusters</span>
                    <span>•</span>
                    <span>{totalArea.toFixed(1)} ha total</span>
                  </div>

                  {/* Interactive Legend with Rename Inputs */}
                  <div className="lulc-section-title">Classify / Label Clusters</div>
                  <div className="flex flex-col gap-1.5">
                    {statsEntries.map(([classVal, info]) => {
                      const currentName = customClusterNames[classVal] || info.name;
                      return (
                        <div key={classVal} className="aef-cluster-row">
                          <span className="aef-color-swatch-circle" style={{ backgroundColor: info.color }}></span>
                          <input 
                            type="text" 
                            value={currentName} 
                            onChange={e => setCustomClusterNames(prev => ({ ...prev, [classVal]: e.target.value }))}
                            className="aef-cluster-input"
                            placeholder={`Rename ${info.name}...`}
                          />
                          <span className="aef-cluster-pct">{info.percentage.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Horizontal Stacked Bar Chart */}
                  <div className="lulc-section-title">Coverage Distribution</div>
                  <div className="lulc-bar-chart">
                    {statsEntries.map(([classVal, info]) => {
                      const label = customClusterNames[classVal] || info.name;
                      return (
                        <div 
                          key={classVal}
                          className="lulc-bar-segment"
                          style={{ 
                            width: `${Math.max(info.percentage, 0.5)}%`, 
                            backgroundColor: info.color 
                          }}
                          title={`${label}: ${info.percentage.toFixed(1)}%`}
                        ></div>
                      );
                    })}
                  </div>

                  {/* SVG Donut Chart */}
                  <div className="lulc-section-title">Class Proportion</div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <svg width={donutSize} height={donutSize} viewBox={`0 0 ${donutSize} ${donutSize}`}>
                      {donutSegments.map((seg, idx) => {
                        const label = customClusterNames[seg.classVal] || seg.info.name;
                        return (
                          <path
                            key={idx}
                            d={seg.pathD}
                            fill={seg.info.color}
                            stroke="var(--bg-card)"
                            strokeWidth="1.5"
                            style={{ cursor: 'pointer' }}
                          >
                            <title>{label}: {seg.info.percentage.toFixed(1)}%</title>
                          </path>
                        );
                      })}
                      <text x={donutCx} y={donutCy - 4} textAnchor="middle" fill="var(--text-main)" fontSize="11" fontWeight="700">
                        {statsEntries.length}
                      </text>
                      <text x={donutCx} y={donutCy + 10} textAnchor="middle" fill="var(--text-muted)" fontSize="8">
                        Clusters
                      </text>
                    </svg>
                  </div>

                  {/* Statistics Table */}
                  <div className="lulc-section-title">Area Statistics</div>
                  <div className="mt-1 overflow-y-auto max-h-[180px] border border-slate-700/60 rounded">
                    <table className="lulc-stats-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>Class</th>
                          <th>Pixels</th>
                          <th>Area (ha)</th>
                          <th>%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statsEntries.map(([classVal, info]) => {
                          const label = customClusterNames[classVal] || info.name;
                          return (
                            <tr key={classVal}>
                              <td><span className="lulc-color-swatch-sm" style={{ backgroundColor: info.color }}></span></td>
                              <td className="font-bold" style={{ color: info.color }}>{label}</td>
                              <td>{info.pixel_count.toLocaleString()}</td>
                              <td>{info.area_ha.toFixed(1)}</td>
                              <td style={{ fontWeight: 'bold' }}>{info.percentage.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Export CSV */}
                  <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-700/60">
                    <span className="text-[10px] text-slate-500 font-bold">
                      Total: {totalArea.toFixed(1)} ha
                    </span>
                    <button onClick={handleAefCsvExport} className="excel-btn">
                      Export CSV
                    </button>
                  </div>
                </div>
                );
              })()}

              {/* AI SIMILARITY RESULTS */}
              {similarityResult && analysisMode === "similarity" && (() => {
                const stats = similarityResult.stats;
                const matchArea = stats.match_area_ha;
                const matchPct = stats.match_percentage;

                const handleSimilarityCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Metric,Value\n";
                  csvContent += `Threshold,${stats.threshold}\n`;
                  csvContent += `Matching Pixels,${stats.match_pixels}\n`;
                  csvContent += `Matching Area (ha),${stats.match_area_ha}\n`;
                  csvContent += `Matching Percentage (%),${stats.match_percentage}%\n`;
                  csvContent += `Min Similarity,${stats.min.toFixed(4)}\n`;
                  csvContent += `Max Similarity,${stats.max.toFixed(4)}\n`;
                  csvContent += `Mean Similarity,${stats.mean.toFixed(4)}\n`;
                  csvContent += `Std Dev Similarity,${stats.std.toFixed(4)}\n`;
                  
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `AEF_Similarity_Search_${similarityResult.year}_T${stats.threshold}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>🤖 AI SIMILARITY ANALYSIS</span>
                    <Cpu size={14} className="text-cyan-400" />
                  </div>

                  <div className="text-[10px] text-slate-400 flex items-center gap-2">
                    <span className="text-cyan-400 font-bold uppercase">AlphaEarth Similarity</span>
                    <span>•</span>
                    <span>Year: {similarityResult.year}</span>
                    <span>•</span>
                    <span>Threshold: {stats.threshold.toFixed(3)}</span>
                  </div>

                  {/* Matching Statistics Card */}
                  <div className="p-3 bg-slate-900/50 rounded border border-cyan-500/20 flex flex-col gap-1.5">
                    <div className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Matching Area Coverage</div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold text-white font-mono">{matchArea.toLocaleString()} ha</span>
                      <span className="text-xs text-slate-400">({matchPct.toFixed(2)}% of ROI)</span>
                    </div>
                    {/* Visual bar chart for coverage */}
                    <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden mt-1">
                      <div 
                        className="bg-cyan-500 h-1.5 rounded-full" 
                        style={{ width: `${matchPct}%` }}
                      ></div>
                    </div>
                  </div>

                  {/* Warning if no matching pixels */}
                  {stats.match_pixels === 0 && (
                    <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 rounded flex items-start gap-2 text-rose-400">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                      <span className="text-[10px] leading-normal">
                        No features matched your query above threshold <strong>{stats.threshold.toFixed(3)}</strong>. Try lowering the threshold slider in the sidebar.
                      </span>
                    </div>
                  )}

                  {/* Cosine Similarity Statistics Grid */}
                  <div className="lulc-section-title">Similarity Statistics</div>
                  <div className="stats-grid">
                    <div className="stat-card">
                      <div className="stat-label">Mean</div>
                      <div className="stat-val high">{stats.mean.toFixed(4)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Std Dev</div>
                      <div className="stat-val">{stats.std.toFixed(4)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Min</div>
                      <div className="stat-val danger">{stats.min.toFixed(4)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Max</div>
                      <div className="stat-val success">{stats.max.toFixed(4)}</div>
                    </div>
                  </div>

                  {/* Export CSV */}
                  <div className="flex justify-between items-center mt-3 pt-2 border-t border-slate-700/60">
                    <span className="text-[10px] text-slate-500 font-bold">
                      Match: {stats.match_pixels.toLocaleString()} px
                    </span>
                    <button onClick={handleSimilarityCsvExport} className="excel-btn">
                      Export CSV
                    </button>
                  </div>
                </div>
                );
              })()}
            </div>
            </>
          )}
        </section>
      </div>

      {/* TELEMETRY FOOTER */}
      <footer className="footer">
        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Satellite className="footer-icon" />
          </div>
          <div>
            <h3>SENSOR PLATFORM</h3>
            <p>
              {analysisMode === "aef" ? "AlphaEarth Foundations" : 
               analysisMode === "similarity" ? "AlphaEarth Foundations" :
               analysisMode === "lulc" ? (lulcDataset === "esa-worldcover" ? "ESA WorldCover" : "IO LULC Annual") :
               selectedSceneMeta ? selectedSceneMeta.sensor : "NO ACTIVE SENSOR"}
            </p>
          </div>
        </div>

        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Clock className="footer-icon" />
          </div>
          <div>
            <h3>ACQUISITION DATE</h3>
            <p>
              {analysisMode === "aef" ? `${aefYear} (Annual Composite)` :
               analysisMode === "similarity" ? `${aefYear} (Annual Composite)` :
               analysisMode === "lulc" ? `${lulcYear} (Annual Classification)` :
               selectedSceneMeta ? selectedSceneMeta.date : "IDLE / PENDING"}
            </p>
          </div>
        </div>

        <div className="footer-feature-item" style={{ overflow: 'visible' }}>
          <div className="feat-icon-wrapper">
            <Layers className="footer-icon" />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'visible' }}>
            <h3>MAP LEGEND</h3>
              {spectralResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>{spectralIndex} Scale</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: getPaletteGradientString() }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>{visMin}</span>
                    <span>{((parseFloat(visMin) + parseFloat(visMax)) / 2).toFixed(1)}</span>
                    <span>{visMax}</span>
                  </div>
                </div>
              )}
              {analysisMode === "similarity" && similarityResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Cosine Similarity Scale</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: getPaletteGradientString() }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>{similarityResult.vis_min.toFixed(2)}</span>
                    <span>{((similarityResult.vis_min + similarityResult.vis_max) / 2).toFixed(2)}</span>
                    <span>{similarityResult.vis_max.toFixed(2)}</span>
                  </div>
                </div>
              )}
          </div>
        </div>

        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Download className="footer-icon" />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h3>RASTER EXPORT</h3>
            {activeTiffUrl ? (
              <a 
                href={`${API_BASE}${activeTiffUrl}`} 
                download
                className="submit-btn-pill active text-center decoration-none"
                style={{ padding: '4px 8px', fontSize: '9px', width: 'auto', marginTop: '4px', display: 'inline-block' }}
              >
                Download TIFF
              </a>
            ) : (
              <button 
                disabled
                className="submit-btn-pill active"
                style={{ padding: '2px 8px', fontSize: '9px', width: 'auto', marginTop: '4px', cursor: 'not-allowed', opacity: 0.5 }}
              >
                Download TIFF
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
