// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ConsentManager
 * @dev Allows users to freely choose a tithing (charitable redirection) preset.
 * The choice is stored per-address. No preset means 0 bps → no tithing applied.
 *
 * Presets are human-readable labels only. The actual rate is controlled by TitheManager.
 * This contract is fully worldview-agnostic.
 */
contract ConsentManager is Ownable {
    // ============ PRESET KEYS ============
    bytes32 public constant CHRISTIAN_TITHE = keccak256("christian-tithe-10pct");
    bytes32 public constant ZAKAT           = keccak256("zakat-2.5pct");
    bytes32 public constant TZEDAKAH        = keccak256("tzedakah-10pct");
    bytes32 public constant SECULAR         = keccak256("secular-custom");
    bytes32 public constant NONE            = keccak256("none-0pct");

    // ============ STORAGE ============
    mapping(address => bytes32) public preset;
    mapping(address => uint256) public customRate;

    // ============ EVENTS ============
    event PresetChanged(address indexed user, bytes32 indexed presetKey, uint256 customBps);
    event PresetRemoved(address indexed user);

    constructor() Ownable(msg.sender) {}

    // ============ USER FUNCTIONS ============
    function setPreset(bytes32 presetKey) external {
        require(
            presetKey == CHRISTIAN_TITHE ||
            presetKey == ZAKAT ||
            presetKey == TZEDAKAH ||
            presetKey == SECULAR ||
            presetKey == NONE,
            "Unknown preset"
        );
        _set(msg.sender, presetKey, 0);
    }

    function setCustomRate(uint256 bps) external {
        require(bps <= 10000, "Invalid rate");
        _set(msg.sender, SECULAR, bps);
    }

    /// @notice Explicitly opt out of tithing (same as removePreset)
    function optOut() public {
        _set(msg.sender, NONE, 0);
    }

    /// @notice Alias for optOut() for better UX
    function removePreset() external {
        optOut();
    }

    // ============ OWNER FUNCTIONS ============
    function clearPreset(address user) external onlyOwner {
        delete preset[user];
        delete customRate[user];
        emit PresetRemoved(user);
    }

    // ============ VIEW FUNCTIONS ============
    function getEffectiveRate(address user)
        external
        view
        returns (uint256 bps, string memory label)
    {
        bytes32 p = preset[user];

        if (p == bytes32(0)) return (0, "");                    // never set
        if (p == CHRISTIAN_TITHE) return (1000, "christian-tithe-10pct");
        if (p == ZAKAT)           return (250, "zakat-2.5pct");
        if (p == TZEDAKAH)        return (1000, "tzedakah-10pct");
        if (p == SECULAR)         return (customRate[user], "secular-custom");
        if (p == NONE)            return (0, "none-0pct");

        return (0, "unknown");
    }

    // ============ INTERNAL ============
    function _set(address user, bytes32 presetKey, uint256 bps) internal {
        preset[user] = presetKey;
        if (presetKey == SECULAR) {
            customRate[user] = bps;
        } else {
            delete customRate[user];
        }
        emit PresetChanged(user, presetKey, bps);
    }
}
