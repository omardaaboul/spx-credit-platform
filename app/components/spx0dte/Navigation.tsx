"use client";

import AppNav from "@/app/components/spx0dte/AppNav";

type NavigationProps = {
  unreadAlerts?: number;
  dataQualityWarning?: boolean;
};

export default function Navigation({ unreadAlerts = 0, dataQualityWarning = false }: NavigationProps) {
  return <AppNav unreadAlerts={unreadAlerts} dataQualityWarning={dataQualityWarning} />;
}

