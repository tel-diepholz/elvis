import { useQuery } from '@tanstack/react-query';
import { defaultEnergyFlow, type EnergyData, type EnergyFlowConfig } from '@elvis/shared';
import { api } from '../../lib/api';
import { useDevice } from '../../lib/live';

/** Live-Werte von Wechselrichter und Bluetooth für den Energiefluss */
export function useEnergyData(): EnergyData & { modules: { inverter: boolean; bluetooth: boolean } } {
  const inverter = useDevice('inverter');
  const bt = useDevice('bluetooth');
  return {
    inverter: inverter?.state ?? null,
    inverterOnline: !!inverter?.online,
    bluetooth: bt?.state.devices ?? [],
    modules: { inverter: !!inverter, bluetooth: !!bt },
  };
}

/** Gespeicherte Belegung oder – ohne Einstellung – die automatische aus den vorhandenen Geräten */
export function useEnergyFlow() {
  const data = useEnergyData();
  const { data: settings, isLoading } = useQuery({ queryKey: ['energyFlow'], queryFn: api.energyFlow });
  const auto = defaultEnergyFlow({ inverter: data.modules.inverter, bluetooth: data.bluetooth });
  const config: EnergyFlowConfig = settings?.config ?? auto;
  return { data, settings, config, auto, custom: !!settings?.config, isLoading };
}
