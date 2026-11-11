import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../context/AuthContext';
import SiteFrame from '../components/SiteFrame';
import AlgorithmSimulation from '../components/AlgorithmSimulation';

// Algorithm Simulation (Superadmin, Simulation Mode). Runs the seeded research simulator in the
// browser on synthetic patients only: no API request, patient record, live queue or Call Now is
// involved, and WRR exists only here.
export default function AlgorithmSimulationPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && user?.role!=='superadmin') router.replace('/login'); },[loading,user,router]);
  if (loading || user?.role!=='superadmin') return <div role="status">Loading Algorithm Simulation…</div>;
  return <SiteFrame>
    <AlgorithmSimulation/>
  </SiteFrame>;
}
