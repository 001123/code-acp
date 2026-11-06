import { Icon } from "../icon";
import robotIcon from "@tabler/icons/outline/robot.svg";

/** The agent's registry icon, tinted with the text color; the robot when it has none. */
export function AgentIcon({ icon }: { icon: string | undefined }) {
  return icon ? <span className="agent-icon" style={{ maskImage: `url("${icon}")` }} /> : <Icon svg={robotIcon} />;
}
