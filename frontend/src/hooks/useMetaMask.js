import { useCallback, useEffect, useMemo, useState } from "react";

const DEFAULT_CHAIN_ID = Number(import.meta.env.VITE_SEPOLIA_CHAIN_ID || 11155111);
const DEFAULT_CHAIN_HEX = `0x${DEFAULT_CHAIN_ID.toString(16)}`;

function parseChainId(chainIdHex) {
  return Number.parseInt(chainIdHex, 16);
}

export function useMetaMask() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletError, setWalletError] = useState("");

  const hasMetaMask = typeof window !== "undefined" && Boolean(window.ethereum);

  const refreshWalletState = useCallback(async () => {
    if (!hasMetaMask) {
      return;
    }

    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    const currentChainHex = await window.ethereum.request({ method: "eth_chainId" });

    setAccount(accounts?.[0] || "");
    setChainId(parseChainId(currentChainHex));
  }, [hasMetaMask]);

  const connectWallet = useCallback(async () => {
    if (!hasMetaMask) {
      setWalletError("MetaMask is required for wallet authentication.");
      return;
    }

    setIsConnecting(true);
    setWalletError("");

    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const currentChainHex = await window.ethereum.request({ method: "eth_chainId" });

      setAccount(accounts?.[0] || "");
      setChainId(parseChainId(currentChainHex));
    } catch (error) {
      setWalletError(error?.message || "Failed to connect MetaMask.");
    } finally {
      setIsConnecting(false);
    }
  }, [hasMetaMask]);

  const switchWalletAccount = useCallback(async () => {
    if (!hasMetaMask) {
      setWalletError("MetaMask is required for wallet authentication.");
      return;
    }

    setWalletError("");

    try {
      // This opens MetaMask account selector for sites that already have permissions.
      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
      await refreshWalletState();
    } catch (error) {
      // Fallback for wallets that do not support wallet_requestPermissions.
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        setAccount(accounts?.[0] || "");
      } catch (fallbackError) {
        setWalletError(fallbackError?.message || "Failed to switch wallet account.");
      }
    }
  }, [hasMetaMask, refreshWalletState]);

  const switchToSepolia = useCallback(async () => {
    if (!hasMetaMask) {
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: DEFAULT_CHAIN_HEX }],
      });
      await refreshWalletState();
    } catch (error) {
      setWalletError(error?.message || `Unable to switch to chain ${DEFAULT_CHAIN_ID}.`);
    }
  }, [hasMetaMask, refreshWalletState]);

  useEffect(() => {
    if (!hasMetaMask) {
      return;
    }

    refreshWalletState();

    const handleAccountsChanged = (accounts) => {
      setAccount(accounts?.[0] || "");
    };

    const handleChainChanged = (nextChainIdHex) => {
      setChainId(parseChainId(nextChainIdHex));
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [hasMetaMask, refreshWalletState]);

  const isSepolia = useMemo(() => chainId === DEFAULT_CHAIN_ID, [chainId]);

  return {
    account,
    chainId,
    hasMetaMask,
    isSepolia,
    isConnecting,
    walletError,
    connectWallet,
    switchWalletAccount,
    switchToSepolia,
    requiredChainId: DEFAULT_CHAIN_ID,
  };
}
