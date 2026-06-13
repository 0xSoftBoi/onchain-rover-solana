// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Treasury — the fleet's earnings vault, governed by a Ledger.
/// @notice Robots earn USDC autonomously, but moving the treasury requires a
/// human to physically clear-sign on a Ledger. owner = a hardware-wallet
/// address; withdraw() is onlyOwner. The withdraw signature is intentionally
/// simple so the ERC-7730 descriptor renders it human-readably on-device:
/// "Withdraw <amount> USDC to <recipient>".
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract Treasury {
    IERC20 public immutable usdc;
    address public owner;   // the Ledger hardware-wallet address

    event Withdraw(address indexed to, uint256 amount);
    event OwnerChanged(address indexed newOwner);

    constructor(address _usdc, address _owner) {
        usdc = IERC20(_usdc);
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Ledger approval required");
        _;
    }

    /// @notice Withdraw fleet earnings. Blocks unless the caller is the
    /// Ledger-held owner — the governance boundary for the demo climax.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(usdc.transfer(to, amount), "transfer failed");
        emit Withdraw(to, amount);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
