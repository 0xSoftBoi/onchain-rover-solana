// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockRaceToken
/// @notice Local-only ERC20 used by the Hardhat race harness.
contract MockRaceToken is ERC20, ERC20Permit, Ownable {
    constructor(address initialOwner)
        ERC20("Rover Race Dollar", "RRD")
        ERC20Permit("Rover Race Dollar")
        Ownable(initialOwner)
    {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
