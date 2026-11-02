import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GreetingScreen } from "./client/greeting";

function GreetingItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      active={currentScreen?.screenId === "greeting"}
      onPress={() => openScreen({ screenId: "greeting" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "greeting", title: "Greeting", Component: GreetingScreen });
  client.addSidebarHeaderItem({ id: "greeting", title: "Greeting", Component: GreetingItem });
  return () => {};
}
