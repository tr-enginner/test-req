import {useState, type ReactNode} from "react";
import {Avatar, Button, Dropdown, Layout, Tooltip} from "antd";
import {ArrowLeftOutlined, CodeOutlined, KeyOutlined, LogoutOutlined, QuestionCircleOutlined, UserAddOutlined, UserOutlined} from "@ant-design/icons";
import {useQueryClient} from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {api, type CurrentUser} from "./api";
import {SettingsModal, type SettingsTab} from "./SettingsModal";

export function settingsTabsForRole(role?: CurrentUser["role"]): SettingsTab[] {
    return role === "ADMIN" ? ["password", "users", "opencode"] : ["password"]
}

export function AppHeader({backTo, backLabel = "返回项目", actions, beforeLeave}: {
    backTo?: string;
    backLabel?: string;
    actions?: ReactNode;
    beforeLeave?: () => boolean
}) {
    const navigate = useNavigate(), queryClient = useQueryClient(), user = queryClient.getQueryData<CurrentUser>(["me"]),
        [settingsOpen, setSettingsOpen] = useState(false), [settingsTab, setSettingsTab] = useState<SettingsTab>("password"),
        roleName = user?.role === "ADMIN" ? "管理员" : user?.role === "REVIEWER" ? "评审员" : "查看者";
    const openSettings = (tab: SettingsTab) => {
        setSettingsTab(tab);
        setSettingsOpen(true)
    };
    const logout = async () => {
        if (beforeLeave && !beforeLeave()) return;
        await api("/auth/logout", {method: "POST"});
        queryClient.setQueryData(["me"], null);
        navigate("/login", {replace: true})
    };
    const settingPresentation = {
        password: {icon: <KeyOutlined/>, label: "修改密码"},
        users: {icon: <UserAddOutlined/>, label: "添加用户"},
        opencode: {icon: <CodeOutlined/>, label: "OpenCode 配置"}
    };
    const settingsItems = settingsTabsForRole(user?.role).map(tab => ({
        key: `settings:${tab}`, ...settingPresentation[tab]
    }));
    return <><Layout.Header className="header"><b>Matrix测试需求管理</b>{backTo &&
        <Button ghost icon={<ArrowLeftOutlined/>} onClick={() => {
            if (!beforeLeave || beforeLeave()) navigate(backTo)
        }}>{backLabel}</Button>}<span className="grow"/>{actions}<Tooltip title="下载使用手册">
        <Button ghost shape="circle" aria-label="下载使用手册" icon={<QuestionCircleOutlined/>}
                href="/manuals/Matrix-Req-Manager用户使用手册.pdf"
                download="Matrix-Req-Manager用户使用手册.pdf"/>
    </Tooltip><Dropdown placement="bottomRight" trigger={["click"]} menu={{
        items: [{key: "account", disabled: true, label: <div className="account-menu-summary">
            <b>{user?.username || "当前用户"}</b><span>{roleName}</span>
        </div>}, {type: "divider"}, ...settingsItems, {type: "divider"},
            {key: "logout", icon: <LogoutOutlined/>, label: "退出登录"}],
        onClick: ({key}) => {
            if (key === "logout") void logout();
            else if (key.startsWith("settings:")) openSettings(key.slice(9) as SettingsTab)
        }
    }}><Button ghost shape="circle" className="account-menu-trigger" aria-label="用户菜单">
        <Avatar size={30} icon={<UserOutlined/>}/>
    </Button></Dropdown></Layout.Header><SettingsModal open={settingsOpen} activeTab={settingsTab} user={user}
        onTabChange={setSettingsTab} onClose={() => setSettingsOpen(false)} beforeLeave={beforeLeave}/></>
}
