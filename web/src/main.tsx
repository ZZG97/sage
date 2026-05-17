import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DebugPage } from './pages/DebugPage';
import { ManagementPage } from './pages/Management';
import { HealthDashboard } from './pages/HealthDashboard';
import { OperationsPage } from './pages/OperationsPage';
import { SchedulerPage } from './pages/SchedulerPage';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/management" replace />} />
          <Route path="/management" element={<ManagementPage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/scheduler" element={<SchedulerPage />} />
          <Route path="/health-dashboard" element={<HealthDashboard />} />
          <Route path="/debug" element={<DebugPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
